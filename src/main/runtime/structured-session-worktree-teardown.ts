/**
 * The structured half of worktree teardown.
 *
 * `killAllProcessesForWorktree` sweeps three PTY surfaces — the renderer graph, the provider's
 * session list, and the local pty-registry — and a structured agent session appears on NONE of
 * them. It has no PTY, no leaf, and no provider session row. So every sweep counted zero, no error
 * was raised, and removal deleted the checkout out from under a running provider child: the child
 * kept running with its `cwd` gone, the durable record and chat tab survived to republish at the
 * next launch pointing at a deleted worktree, and `worker-show` still reported the worker live.
 *
 * Membership is `location.workspaceId`, which every structured session carries — so this covers a
 * plain chat session in the worktree as well as a dispatched worker. Liveness is
 * `observeStructuredWorker`, the same `live` / `unverifiable` / `exited` vocabulary the rest of the
 * structured surface uses; only a PROVEN live child is worth refusing a removal over.
 */

import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import { observeStructuredWorker } from './structured-worker-authority'
import { closeStructuredAgentSessionChild } from './structured-agent-session-close'
import type { OrcaRuntimeService } from './orca-runtime'

export type LiveStructuredSessionInWorkspace = {
  sessionId: string
  agent: 'claude' | 'codex'
}

export type StructuredWorktreeSweepRuntime = Pick<
  OrcaRuntimeService,
  'forgetStructuredSessionMail' | 'retireStructuredAgentSessionTabFromSnapshot'
>

/**
 * Structured sessions with a proven-live child in this worktree.
 *
 * An uninstalled host answers empty rather than throwing: no host in this generation means no
 * provider child was started by this process, and the three PTY sweeps fall through the same way
 * when their surface is unavailable. It is deliberately NOT read through the persisted store
 * directly — that would force-install the host, which is itself a side effect on a teardown path.
 */
export function listLiveStructuredSessionsForWorktree(
  worktreeId: string
): LiveStructuredSessionInWorkspace[] {
  const host = getStructuredAgentSessionHost()
  if (!host) {
    return []
  }
  let records: ReturnType<typeof host.deps.store.listRecords>
  try {
    records = host.deps.store.listRecords()
  } catch {
    return []
  }
  return records
    .filter(
      (record) =>
        record.location.workspaceId === worktreeId &&
        observeStructuredWorker({ sessionId: record.sessionId }).status === 'live'
    )
    .map((record) => ({ sessionId: record.sessionId, agent: record.provider }))
}

export function describeLiveStructuredSessions(
  worktreeId: string,
  sessions: readonly LiveStructuredSessionInWorkspace[]
): string {
  const noun = sessions.length === 1 ? 'agent session' : 'agent sessions'
  return `${sessions.length} running ${noun} in ${worktreeId} (${sessions
    .map((session) => `${session.agent}:${session.sessionId}`)
    .join(', ')})`
}

/**
 * Closes every live structured session in the worktree, and reports what stayed.
 *
 * Force is the documented escape hatch, so it closes rather than orphaning: a child left running
 * against a deleted `cwd` is the exact outcome this whole sweep exists to prevent.
 */
export async function closeStructuredSessionsForWorktree(
  worktreeId: string,
  runtime?: StructuredWorktreeSweepRuntime
): Promise<{ closed: number; unstopped: LiveStructuredSessionInWorkspace[] }> {
  const sessions = listLiveStructuredSessionsForWorktree(worktreeId)
  const unstopped: LiveStructuredSessionInWorkspace[] = []
  let closed = 0
  for (const session of sessions) {
    const outcome = await closeStructuredAgentSessionChild(
      session.sessionId,
      runtime ? { runtime } : {}
    )
    if (outcome.stopped) {
      closed += 1
    } else {
      unstopped.push(session)
    }
  }
  return { closed, unstopped }
}
