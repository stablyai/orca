import type { ExecutionHostId } from '../../../shared/execution-host'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type {
  TerminalLeafMoveRequest,
  TerminalLeafMoveResult
} from '../../../shared/terminal-leaf-move'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import type {
  CommandOf,
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
import type { DurableProfileStateMutation } from '../loading-store/store-runtime-state'
import { planTerminalLeafMove, rekeyMovedLeafProfileRecords } from './terminal-leaf-move'
import { assignWorkspaceSessionPartition } from './terminal-topology-membership'

// The commit boundary for terminal layout (tabs, panes, pane-to-PTY bindings). Wraps the close and
// the pane move; the close transform still lives in runtime/ and other writers move here later.

/** Bindings are not listed: `persistPtyBinding` already records `persistence.pty-binding`. */
type TerminalTopologyCommitKind =
  | 'close_leaf'
  | 'close_tab'
  | 'move_leaf'
  | 'admit_pane'
  | 'withdraw_pane'

export function closeLeafOrTab(
  commit: TerminalSurfaceCloseCommit
): () => DurableProfileStateMutation<Error | undefined> {
  return traced(
    commit.target.kind === 'pane' ? 'close_leaf' : 'close_tab',
    terminalSurfaceCloseMutation(commit),
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
    () =>
      commitPaneChange(
        hostId,
        admitPaneToSession(hostId, context.getSession(hostId), admission),
        context
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
    () =>
      commitPaneChange(
        hostId,
        withdrawPaneFromSession(hostId, context.getSession(hostId), pane),
        context
      ),
    (code) => code ?? undefined
  )
}

/**
 * One `persistence.terminal-topology` span per commit, from admission to the in-memory write.
 * Attributes stay low-cardinality: no pane key, PTY id or path; `refusalOf` returns a fixed code.
 */
function traced<T>(
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
}

/** Writes `next`, returning a restore that puts the prior value back unless a later write replaced it. */
function writeRestorable<V>(read: () => V, write: (value: V) => void, next: V): () => void {
  const prior = read()
  write(next)
  return () => {
    if (read() === next) {
      write(prior)
    }
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
      session
    )
  )
  const rekeyed = rekeyMovedLeafProfileRecords(state, request)
  if (rekeyed.ui) {
    restores.push(
      writeRestorable(
        () => state.ui,
        (ui) => (state.ui = ui),
        rekeyed.ui
      )
    )
    context.markDirty('ui')
  }
  if (rekeyed.sshRemotePtyLeases) {
    restores.push(
      writeRestorable(
        () => state.sshRemotePtyLeases,
        (leases) => (state.sshRemotePtyLeases = leases),
        rekeyed.sshRemotePtyLeases
      )
    )
    context.markDirty('sshRemotePtyLeases')
  }
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
    change.session
  )
  return { value: change.value, rollback: restore }
}
