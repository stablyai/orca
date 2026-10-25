/** Structured children appear on no PTY surface, so teardown must close them separately before deleting cwd.
 * Fence membership by workspace and host; lease liveness selects children to close, while only an unproven close can refuse removal. */

import {
  LOCAL_EXECUTION_HOST_ID,
  toRuntimeExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../shared/execution-host'
import { STILL_LIVE_DETAIL_PREFIX } from '../../shared/worktree/removal'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import {
  observeStructuredSession,
  structuredSessionCloseSettled
} from './structured-worker-authority'
import { closeStructuredAgentSessionChild } from './agent-session/structured-agent-session-close'
import { retireSettledStructuredWorkerTab } from './agent-session/structured-agent-session-tab-retirement'
import type { WorktreePtyHostFence } from './worktree-pty-host-fence'
import { getRepoIdFromWorktreeId } from '../../shared/worktree/id'
import type { OrcaRuntimeService } from './orca-runtime'
import type { StructuredAgentId } from '../../shared/agent-session-provider-handle'

export type StructuredSessionInWorkspace = {
  sessionId: string
  agent: StructuredAgentId
}

export type UnclosedStructuredSession = StructuredSessionInWorkspace & {
  /** Read AFTER the close: `live` is a child watched stay attached, not merely one left unproven. */
  status: 'live' | 'unverifiable'
}

export type StructuredWorktreeSweepRuntime = Pick<
  OrcaRuntimeService,
  'forgetStructuredSessionMail' | 'retireStructuredAgentSessionTabFromSnapshot'
>

/** Reuse the PTY fence type; null means local for both, but absent is deliberately local here rather than all hosts to avoid closing other hosts' chats. */
export type StructuredSessionHostFence = WorktreePtyHostFence

/** Workspace ids omit host identity (STA-4343); compare executionHostId using the PTY sweep's resolved runtime/connection fence. */
export function structuredSessionTeardownHostId(
  fence: StructuredSessionHostFence
): ExecutionHostId {
  if (fence.resolvedRuntimeEnvironmentId !== undefined) {
    return toRuntimeExecutionHostId(fence.resolvedRuntimeEnvironmentId)
  }
  // Both absent and null connection fences select only this machine.
  const connectionId = fence.resolvedConnectionId ?? null
  return connectionId === null ? LOCAL_EXECUTION_HOST_ID : toSshExecutionHostId(connectionId)
}

/** Track all workspace members separately from attached children so chats at rest cannot outlive workspace deletion. */
export type StructuredSessionsForWorktree = {
  /** Every session bound to this workspace on the fenced host, attached or not. */
  members: StructuredSessionInWorkspace[]
  /** The subset with a proven-live provider child: what the sweep closes and may refuse over. */
  live: StructuredSessionInWorkspace[]
}

/** Enumerate/observe members once; an uninstalled host answers empty. Reading persisted storage would force-install it during teardown. */
export function listStructuredSessionsForWorktree(
  worktreeId: string,
  fence: StructuredSessionHostFence
): StructuredSessionsForWorktree {
  return listFencedStructuredSessions((workspaceId) => workspaceId === worktreeId, fence)
}

export function listStructuredSessionsForProject(
  repoId: string,
  fence: StructuredSessionHostFence
): StructuredSessionsForWorktree {
  return listFencedStructuredSessions(
    (workspaceId) => getRepoIdFromWorktreeId(workspaceId) === repoId,
    fence
  )
}

function listFencedStructuredSessions(
  inScope: (workspaceId: string) => boolean,
  fence: StructuredSessionHostFence
): StructuredSessionsForWorktree {
  const host = getStructuredAgentSessionHost()
  if (!host) {
    return { members: [], live: [] }
  }
  let records: ReturnType<typeof host.deps.store.listRecords>
  try {
    records = host.deps.store.listRecords()
  } catch {
    return { members: [], live: [] }
  }
  const hostId = structuredSessionTeardownHostId(fence)
  const members = records
    .filter(
      (record) => inScope(record.location.workspaceId) && record.location.executionHostId === hostId
    )
    .map((record) => ({ sessionId: record.sessionId, agent: record.provider }))
  return {
    members,
    live: members.filter((session) => observeStructuredSession(session.sessionId).status === 'live')
  }
}

/** Expose only counts/providers: session ids lead to mailbox-gating pane keys and this text reaches agents and desktop toasts. */
function countStructuredSessions(sessions: readonly UnclosedStructuredSession[]): string {
  const noun = sessions.length === 1 ? 'agent session' : 'agent sessions'
  const providers = [...new Set(sessions.map((session) => session.agent))].sort().join(', ')
  return `${sessions.length} ${noun} (${providers})`
}

/** Report live and unverifiable separately: both remain unclosed, but only live uses the desktop force-delete marker. */
export function describeUnclosedStructuredSessions(
  sessions: readonly UnclosedStructuredSession[]
): string {
  const stillLive = sessions.filter((session) => session.status === 'live')
  const unconfirmed = sessions.filter((session) => session.status !== 'live')
  if (stillLive.length === 0) {
    return `could not confirm these closed: ${countStructuredSessions(unconfirmed)}`
  }
  const live = `${STILL_LIVE_DETAIL_PREFIX} ${countStructuredSessions(stillLive)}`
  return unconfirmed.length === 0
    ? live
    : `${live}; could not confirm these closed: ${countStructuredSessions(unconfirmed)}`
}

/** Publish progress during serial closes so timeout reports actual outcomes rather than treating completed closes as unclosed. */
export type StructuredSweepProgress = {
  /** The sessions this sweep closes, in the order the loop reaches them. */
  readonly sessions: readonly StructuredSessionInWorkspace[]
  /** Sessions no longer attached after their close — the count this sweep reports. */
  closed: number
  /** Attempted closes that did not settle, each carrying the verdict re-read after the attempt. */
  unstopped: UnclosedStructuredSession[]
  /** How many of `sessions`, from the front, have an outcome recorded. */
  settled: number
}

export function createStructuredSweepProgress(
  sessions: readonly StructuredSessionInWorkspace[]
): StructuredSweepProgress {
  return { sessions, closed: 0, unstopped: [], settled: 0 }
}

/** Unattempted or in-flight closes are unverifiable; only observed exits leave the unclosed list. */
export function unclosedStructuredSessions(
  progress: StructuredSweepProgress
): UnclosedStructuredSession[] {
  return [
    ...progress.unstopped,
    ...progress.sessions
      .slice(progress.settled)
      .map((session) => ({ ...session, status: 'unverifiable' as const }))
  ]
}

/** Close the supplied set on ordinary and forced removal; deadline leaves unattempted sessions unverifiable without re-enumerating. */
export async function closeStructuredSessionsForWorktree(
  progress: StructuredSweepProgress,
  deadline: number,
  options: {
    runtime?: StructuredWorktreeSweepRuntime
    /** Restore tabs after unproven close only if removal can refuse; force/folder paths discard the workspace regardless. */
    mayRefuse?: boolean
  } = {}
): Promise<void> {
  const { runtime, mayRefuse } = options
  // Omit afterClose: dispatch redrive/registry entries survive until separate settlement; resolving dispatch ids here would spend the sweep budget.
  for (const session of progress.sessions) {
    // Stop issuing at the deadline; in-flight provider round trips cannot be cancelled.
    if (Date.now() >= deadline) {
      return
    }
    const outcome = await closeStructuredAgentSessionChild(session.sessionId, {
      ...(runtime ? { runtime } : {}),
      restoreTabOnUnprovenClose: mayRefuse === true
    })
    if (outcome.stopped) {
      progress.closed += 1
    } else {
      // Read post-attempt state; a thrown close may never have observed it.
      const status = observeStructuredSession(session.sessionId).status
      if (status === 'exited' || structuredSessionCloseSettled(session.sessionId)) {
        // Exit evidence may land during rollback's tab-restore write; undo that restored reference before counting the child closed.
        await dropDurableChatTabReference(session.sessionId)
        retireSettledStructuredWorkerTab(session.sessionId, runtime)
        progress.closed += 1
      } else {
        progress.unstopped.push({ ...session, status })
      }
    }
    // Record progress only after observation so an in-flight close remains unclosed at timeout.
    progress.settled += 1
  }
}

/** Retire every member's durable/snapshot tabs, including chats at rest missed by close.
 * Call only after removal cannot refuse; otherwise the surviving workspace must retain its tabs.
 * Serial best-effort bookkeeping cannot refuse teardown or leave index entries to resurrect deleted workspaces. */
export async function retireStructuredSessionTabsForWorktree(
  sessions: readonly StructuredSessionInWorkspace[],
  runtime?: StructuredWorktreeSweepRuntime
): Promise<void> {
  for (const session of sessions) {
    await dropDurableChatTabReference(session.sessionId)
    retireSettledStructuredWorkerTab(session.sessionId, runtime)
  }
}

/** Drop a tab restored by an unproven close when this sweep later proves exit; bookkeeping cannot fail settlement. */
async function dropDurableChatTabReference(sessionId: string): Promise<void> {
  const host = getStructuredAgentSessionHost()
  try {
    await host?.setSessionTabVisibility?.(sessionId, false)
  } catch (error) {
    host?.deps.logger.warn('dropping a removed workspace chat tab reference failed', {
      scope: 'teardown-tab-drop',
      sessionId,
      error
    })
  }
}
