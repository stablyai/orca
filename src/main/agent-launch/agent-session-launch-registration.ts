// Shared spawn-success registration of a launch's host-private resume attribution
// (U5, §577). Every launch surface (desktop pty:spawn, mobile/paired runtime
// terminal create, worktree-create agent terminal) calls this right after it
// settles its admission token 'registered', so the immutable snapshot + token are
// staged in the session record store keyed by launch token. A later provider hook
// binds the session and promotes the staging to a durable, resumable record.
//
// The snapshot is read from the boundary's retained admitted record — it is
// host-private and never travels on the client receipt.

import type { AgentLaunchReceipt } from '../../shared/agent-launch-contract'
import type { AgentLaunchBoundary } from './agent-launch-boundary'
import type { AgentSessionRecordStore } from './agent-session-record-store'

export type RegisterHostSessionLaunchArgs = {
  boundary: AgentLaunchBoundary
  store: AgentSessionRecordStore
  launchToken: string
  worktreeId: string
  receipt: AgentLaunchReceipt
  /** Optional attribution metadata: a stable pane key lets a pane teardown drop
   *  unbound staging. Surfaces without one omit it; the token drives bind. */
  paneKey?: string
  terminalId?: string
}

/** Stage the resume attribution for a freshly launched agent. Works whether the
 *  caller has already settled the admission token 'registered' (retained record)
 *  or is still mid-spawn (pending admission snapshot). A no-op when the admitted
 *  snapshot is gone (e.g. the launch was never admitted) or the worktree id is
 *  empty — a record with no worktree could never be resolved by an ownership key. */
export function registerHostSessionLaunch(args: RegisterHostSessionLaunchArgs): void {
  if (!args.worktreeId) {
    return
  }
  const launchSnapshot =
    args.boundary.retainedFor(args.launchToken)?.snapshot ??
    args.boundary.pendingSnapshotFor(args.launchToken)
  if (!launchSnapshot) {
    return
  }
  args.store.register({
    ...(args.paneKey ? { paneKey: args.paneKey } : {}),
    ...(args.terminalId ? { terminalId: args.terminalId } : {}),
    worktreeId: args.worktreeId,
    requestedAgent: args.receipt.requestedAgent,
    baseAgent: args.receipt.baseAgent,
    launchSnapshot,
    launchToken: args.launchToken
  })
}
