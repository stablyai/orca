import type { ExecutionHostId } from '../../../shared/execution-host'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type {
  TerminalLeafMoveRequest,
  TerminalLeafMoveResult
} from '../../../shared/terminal-leaf-move'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import type {
  CommandOf,
  LayoutApplyOutcome,
  LayoutCommand,
  LayoutRefusalCode
} from '../../../shared/workspace-layout/workspace-layout-command-types'
import {
  admitPaneToSession,
  withdrawPaneFromSession,
  type PaneLayoutChange,
  type TerminalPaneAdmission,
  type TerminalPaneAdmissionOutcome
} from './terminal-pane-admission'
import { startSpan } from '../../observability/tracer'
import {
  terminalSurfaceCloseMutation,
  type TerminalSurfaceCloseCommit
} from '../../runtime/terminal-surface-close'
import type {
  DurableProfileStateMutation,
  StoreRuntimeState
} from '../loading-store/store-runtime-state'
import type { SessionHostPartitionOperations } from '../loading-store/session-host-partitions'
import { planTerminalLeafMove, writeMovedLeafProfileRecords } from './terminal-leaf-move'
import { writeRestorable } from './restorable-write'
import { assignWorkspaceSessionPartition } from './terminal-topology-membership'
import {
  commitLayoutCommand,
  commitLayoutCommandsAcrossPartitions,
  commitWindowPaneDetach,
  keepFrozen
} from './layout-command-commit'
import {
  fencedIfLayoutOwner,
  layoutCommandFence,
  partitionsFence
} from './closed-pane-binding-fence'

// The commit boundary for terminal layout (tabs, panes, pane-to-PTY bindings). Wraps the close and
// the pane move; the close transform still lives in runtime/ and other writers move here later.

/** Bindings are not listed: `persistPtyBinding` already records `persistence.pty-binding`. */
type TerminalTopologyCommitKind =
  | 'close_leaf'
  | 'close_tab'
  | 'move_leaf'
  | 'admit_pane'
  | 'withdraw_pane'
  | 'apply_layout'

export function closeLeafOrTab(
  commit: TerminalSurfaceCloseCommit
): () => DurableProfileStateMutation<Error | undefined> {
  return traced(
    commit.target.kind === 'pane' ? 'close_leaf' : 'close_tab',
    // A start under way in a pane main closed must not bring it back.
    fencedIfLayoutOwner(
      () => ({ sessions: commit, fences: true }),
      terminalSurfaceCloseMutation(commit)
    ),
    // Refusals are fixed reason codes, never ids.
    (refusal) => refusal?.message
  )
}

/** Moves a leaf, its binding and its pane-keyed records into a new tab in one durable mutation. */
export function moveLeaf(
  request: TerminalLeafMoveRequest,
  context: TerminalTopologyCommitContext
): () => DurableProfileStateMutation<TerminalLeafMoveResult> {
  return traced(
    'move_leaf',
    () => commitLeafMove(request, context),
    (result) => (result.status === 'refused' ? result.reason : undefined)
  )
}

/**
 * Writes the pane, its tab-bar entry and group before its terminal starts (design 4.1), through the
 * layout module.
 */
export function admitPane(
  hostId: ExecutionHostId,
  admission: TerminalPaneAdmission,
  context: TerminalTopologyCommitContext
): () => DurableProfileStateMutation<TerminalPaneAdmissionOutcome> {
  return traced(
    'admit_pane',
    // A pane main writes again under a closed pane's id binds as any.
    fencedIfLayoutOwner(
      () => partitionsFence([hostId], context.getSession, false),
      () =>
        commitPaneChange(
          hostId,
          admitPaneToSession(hostId, context.getSession(hostId), admission),
          context
        )
    ),
    (outcome) => (outcome === 'admitted' || outcome === 'exists' ? undefined : outcome)
  )
}

/** Removes a pane `admitPane` wrote whose start then failed, so a failed create leaves no tab. */
export function withdrawPane(
  hostId: ExecutionHostId,
  pane: CommandOf<'closePane'>,
  context: TerminalTopologyCommitContext
): () => DurableProfileStateMutation<LayoutRefusalCode | null> {
  return traced(
    'withdraw_pane',
    // A start under way in a pane main took back must not bring it back.
    fencedIfLayoutOwner(
      () => partitionsFence([hostId], context.getSession, true),
      () =>
        commitPaneChange(
          hostId,
          withdrawPaneFromSession(hostId, context.getSession(hostId), pane),
          context
        )
    ),
    (code) => code ?? undefined
  )
}

/**
 * A client's layout command (`layout.apply`), applied to each partition holding its tab, routed
 * partition first: that partition's outcome is the reply, and its refusal writes nothing.
 */
export function applyLayout(
  hostIds: readonly ExecutionHostId[],
  command: LayoutCommand,
  context: TerminalTopologyCommitContext
): () => DurableProfileStateMutation<LayoutApplyOutcome> {
  return traced(
    'apply_layout',
    // Closes fence the panes they removed; creates lift the fence on the ids they write.
    fencedIfLayoutOwner(
      () => layoutCommandFence(command.type, hostIds, context.getSession),
      () =>
        command.type === 'movePaneToNewTab' && command.windowDetach
          ? commitWindowPaneDetach(
              hostIds,
              { ...command, windowDetach: command.windowDetach },
              context
            )
          : commitLayoutCommand(hostIds, command, context)
    ),
    (outcome) => (outcome.ok ? undefined : outcome.code)
  )
}

/** One disk move's editor renames, a command per partition, in one durable write of all. */
export function applyEditorFileRenamesInPartitions(
  batches: readonly { hostId: ExecutionHostId; command: CommandOf<'renameEditorFiles'> }[],
  context: TerminalTopologyCommitContext
): () => DurableProfileStateMutation<LayoutApplyOutcome> {
  return traced(
    'apply_layout',
    () => commitLayoutCommandsAcrossPartitions(batches, context),
    (outcome) => (outcome.ok ? undefined : outcome.code)
  )
}

/**
 * One `persistence.terminal-topology` span per commit, from admission to the in-memory write.
 * Attributes stay low-cardinality: no pane key, PTY id or path; `refusalOf` returns a fixed code.
 */
export function traced<T>(
  kind: TerminalTopologyCommitKind,
  mutate: () => DurableProfileStateMutation<T>,
  refusalOf: (value: T) => string | undefined
): () => DurableProfileStateMutation<T> {
  return () => {
    const span = startSpan('persistence.terminal-topology', {
      attributes: { kind: 'persistence', 'topology.kind': kind }
    })
    let result: DurableProfileStateMutation<T>
    // Why only mutate(): `threw` must mean the write failed, never that tracing did.
    try {
      result = mutate()
    } catch (error) {
      span.setAttribute('topology.outcome', 'threw')
      span.fail(error instanceof Error ? error : String(error))
      throw error
    }
    const refusal = refusalOf(result.value)
    if (refusal !== undefined) {
      span.setAttribute('topology.outcome', 'refused')
      span.setAttribute('topology.refusal', refusal)
    } else {
      span.setAttribute('topology.outcome', result.persist === false ? 'noop' : 'committed')
    }
    span.end()
    return result
  }
}

type TopologyState = Pick<
  PersistedState,
  'workspaceSession' | 'workspaceSessionsByHostId' | 'ui' | 'sshRemotePtyLeases'
>

export type TerminalTopologyCommitContext = {
  state: TopologyState
  hostIds: () => ExecutionHostId[]
  getSession: (hostId: ExecutionHostId) => WorkspaceSessionState
  markDirty: (
    domain: 'workspaceSession' | 'workspaceSessionsByHostId' | 'ui' | 'sshRemotePtyLeases'
  ) => void
  /** Main's in-memory editor views; absent where a commit never changes them. */
  editorViews?: Pick<StoreRuntimeState, 'layoutEditorViews'>
}

/** The commit context over a Store's state and its session partitions. */
export function topologyCommitContext({
  runtime,
  sessions
}: {
  runtime: Pick<StoreRuntimeState, 'state' | 'dirtyProfileStateDomains'> &
    Partial<Pick<StoreRuntimeState, 'layoutEditorViews'>>
  sessions: Pick<
    SessionHostPartitionOperations,
    'getWorkspaceSessionHostIds' | 'getWorkspaceSession'
  >
}): TerminalTopologyCommitContext {
  return {
    state: runtime.state,
    hostIds: () => sessions.getWorkspaceSessionHostIds(),
    getSession: (hostId) => sessions.getWorkspaceSession(hostId),
    markDirty: (domain) => runtime.dirtyProfileStateDomains?.add(domain),
    ...(runtime.layoutEditorViews
      ? { editorViews: { layoutEditorViews: runtime.layoutEditorViews } }
      : {})
  }
}

function commitLeafMove(
  request: TerminalLeafMoveRequest,
  context: TerminalTopologyCommitContext
): DurableProfileStateMutation<TerminalLeafMoveResult> {
  const { state } = context
  const planned = planTerminalLeafMove(
    context.hostIds().map((hostId) => ({ hostId, session: context.getSession(hostId) })),
    request
  )
  if (planned.sessions.length === 0) {
    return { value: planned.result, persist: false }
  }
  const restores = planned.sessions.map(({ hostId, session }) =>
    writeRestorable(
      () => context.getSession(hostId),
      (value) => context.markDirty(assignWorkspaceSessionPartition(state, hostId, value)),
      keepFrozen(hostId, session, context)
    )
  )
  restores.push(...writeMovedLeafProfileRecords(request, context))
  return {
    value: planned.result,
    rollback: () => restores.forEach((restore) => restore())
  }
}

function commitPaneChange<T>(
  hostId: ExecutionHostId,
  change: PaneLayoutChange<T>,
  context: TerminalTopologyCommitContext
): DurableProfileStateMutation<T> {
  if (!change.session) {
    return { value: change.value, persist: false }
  }
  const restore = writeRestorable(
    () => context.getSession(hostId),
    (value) => context.markDirty(assignWorkspaceSessionPartition(context.state, hostId, value)),
    keepFrozen(hostId, change.session, context)
  )
  return { value: change.value, rollback: restore }
}
