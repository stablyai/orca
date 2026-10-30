import type { ExecutionHostId } from '../../../shared/execution-host'
import { hasClosedTerminalTabRecord } from '../../../shared/closed-terminal-tab-tombstones'
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
  keepFrozen,
  type LayoutCommandRun
} from './layout-command-commit'
import {
  fencedIfLayoutOwner,
  layoutCommandFence,
  partitionsFence
} from './closed-pane-binding-fence'

/** Binding writes already have their own persistence.pty-binding span. */
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
    // Fence late spawns against resurrecting closed panes.
    fencedIfLayoutOwner(
      () => ({ sessions: commit, fences: true }),
      terminalSurfaceCloseMutation(commit)
    ),
    // Refusals must contain fixed codes, never IDs.
    (refusal) => refusal?.message
  )
}

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

/** Persist pane, tab-bar and group membership before starting the terminal. */
export function admitPane(
  hostId: ExecutionHostId,
  admission: TerminalPaneAdmission,
  context: TerminalTopologyCommitContext
): () => DurableProfileStateMutation<TerminalPaneAdmissionOutcome> {
  return traced(
    'admit_pane',
    // Explicit recreation under the same ID lifts the old pane fence.
    fencedIfLayoutOwner(
      () => partitionsFence([hostId], context.getSession, false),
      () => {
        // A legacy reattach can land outside the partition that recorded the tab's close.
        if (
          admission.type === 'createTerminalTab' &&
          context
            .hostIds()
            .some((id) =>
              hasClosedTerminalTabRecord(
                context.getSession(id).closedTerminalTabTombstonesByTabId,
                admission.tabId,
                admission.workspace
              )
            )
        ) {
          return { value: 'tab_closed', persist: false }
        }
        return commitPaneChange(
          hostId,
          admitPaneToSession(hostId, context.getSession(hostId), admission),
          context
        )
      }
    ),
    (outcome) => (outcome === 'admitted' || outcome === 'exists' ? undefined : outcome)
  )
}

/** Remove failed-start admissions so failed creates leave no empty tabs. */
export function withdrawPane(
  hostId: ExecutionHostId,
  pane: CommandOf<'closePane'>,
  context: TerminalTopologyCommitContext
): () => DurableProfileStateMutation<LayoutRefusalCode | null> {
  return traced(
    'withdraw_pane',
    // Fence late spawns against resurrecting withdrawn panes.
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

/** Apply to all holders, routed first; its result is the reply and its refusal prevents all writes. */
export function applyLayout(
  hostIds: readonly ExecutionHostId[],
  command: LayoutCommand,
  context: TerminalTopologyCommitContext,
  run: LayoutCommandRun = {}
): () => DurableProfileStateMutation<LayoutApplyOutcome> {
  return traced(
    'apply_layout',
    fencedIfLayoutOwner(
      () => layoutCommandFence(command.type, hostIds, context.getSession),
      () =>
        command.type === 'movePaneToNewTab' && command.windowDetach
          ? commitWindowPaneDetach(
              hostIds,
              { ...command, windowDetach: command.windowDetach },
              context
            )
          : commitLayoutCommand(hostIds, command, context, run)
    ),
    (outcome) => (outcome.ok ? undefined : outcome.code)
  )
}

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

/** Trace admission through mutation with fixed refusal codes; exclude pane/PTY IDs and paths. */
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
    // Trace failures must not be classified as mutation failures.
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
  /** Omitted when commits do not change in-memory editor views. */
  editorViews?: Pick<StoreRuntimeState, 'layoutEditorViews'>
}

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
