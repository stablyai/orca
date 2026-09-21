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
 * Membership is `location.workspaceId` PLUS the host fence below, and every structured session
 * carries both — so this covers a plain chat session in the worktree as well as a dispatched
 * worker. Liveness is `observeStructuredWorker`, the same `live` / `unverifiable` / `exited`
 * vocabulary the rest of the structured surface uses.
 *
 * `live` here is lease state — a provider child is attached — not work in flight, so it says
 * nothing about whether the user would lose anything. It selects what to CLOSE, never what to
 * refuse over: a removal refuses only on a close that did not settle, exactly as the PTY sweep
 * refuses only on a stop it could not verify.
 */

import {
  LOCAL_EXECUTION_HOST_ID,
  toRuntimeExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../shared/execution-host'
import { STILL_LIVE_DETAIL_PREFIX } from '../../shared/worktree/removal'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import { observeStructuredWorker } from './structured-worker-authority'
import { closeStructuredAgentSessionChild } from './structured-agent-session-close'
import { retireSettledStructuredWorkerTab } from './structured-agent-session-tab-retirement'
import type { WorktreePtyHostFence } from './worktree-pty-host-fence'
import type { OrcaRuntimeService } from './orca-runtime'

export type StructuredSessionInWorkspace = {
  sessionId: string
  agent: 'claude' | 'codex'
}

export type UnclosedStructuredSession = StructuredSessionInWorkspace & {
  /** Read AFTER the close: `live` is a child watched stay attached, not merely one left unproven. */
  status: 'live' | 'unverifiable'
}

export type StructuredWorktreeSweepRuntime = Pick<
  OrcaRuntimeService,
  'forgetStructuredSessionMail' | 'retireStructuredAgentSessionTabFromSnapshot'
>

/**
 * The two fields every teardown caller already resolves to fence its PTY sweeps to one host.
 *
 * Deliberately the PTY fence's own type rather than a look-alike: these two helpers are written
 * against each other, so a widening on one side must not become a silent disagreement on the
 * other. `resolvedConnectionId: null` means this machine on both.
 *
 * They differ in exactly one reading, and only that one: ABSENT. The PTY fence takes it as no
 * fence at all and matches every host, which a single-host-id comparison cannot express — and
 * closing every host's chats is destructive, not merely noisy. So this side reads absent as local
 * too, the narrower half of that pair. Pinned by test, not left to the next reader to rediscover.
 */
export type StructuredSessionHostFence = WorktreePtyHostFence

/**
 * The one execution host this teardown may touch.
 *
 * A workspace id is `repoId::path` with no host component, so the local machine, an SSH host and a
 * paired runtime can all publish the SAME id and each names a DIFFERENT workspace (STA-4343). The
 * PTY sweeps fence on exactly these two fields; a structured session records its host directly, so
 * the comparison is on `location.executionHostId` instead of on a pty-id shape.
 */
export function structuredSessionTeardownHostId(
  fence: StructuredSessionHostFence
): ExecutionHostId {
  if (fence.resolvedRuntimeEnvironmentId !== undefined) {
    return toRuntimeExecutionHostId(fence.resolvedRuntimeEnvironmentId)
  }
  // Both no-connection readings collapse here on purpose — see the fence type. A caller that
  // resolved no host, and one that resolved this machine, each close nothing on anyone else's.
  const connectionId = fence.resolvedConnectionId ?? null
  return connectionId === null ? LOCAL_EXECUTION_HOST_ID : toSshExecutionHostId(connectionId)
}

/**
 * The workspace's structured sessions, split into what belongs to it and what is attached.
 *
 * MEMBERSHIP and LIVENESS answer different questions, and folding them into one list is what let
 * a chat tab outlive its workspace. A provider child is scoped to a VISIBLE pane — the hold that
 * keeps one is `enabled: isVisible && isWorktreeActive`, and dropping the last hold evicts the
 * child after the release grace — so `live` really means "this chat is the visible pane in the
 * active workspace, or was moments ago". Deleting a workspace from the sidebar while a different
 * one is active makes every chat in the target non-live. Those are exactly the sessions a
 * liveness-only list never saw.
 */
export type StructuredSessionsForWorktree = {
  /** Every session bound to this workspace on the fenced host, attached or not. */
  members: StructuredSessionInWorkspace[]
  /** The subset with a proven-live provider child: what the sweep closes and may refuse over. */
  live: StructuredSessionInWorkspace[]
}

/**
 * Structured sessions in this worktree, on the fenced host only.
 *
 * An uninstalled host answers empty rather than throwing: no host in this generation means no
 * provider child was started by this process, and the three PTY sweeps fall through the same way
 * when their surface is unavailable. It is deliberately NOT read through the persisted store
 * directly — that would force-install the host, which is itself a side effect on a teardown path.
 *
 * One enumeration and one observation per member, because both answers are read by the same
 * caller: re-deriving the live subset separately would run every liveness observation twice.
 */
export function listStructuredSessionsForWorktree(
  worktreeId: string,
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
      (record) =>
        record.location.workspaceId === worktreeId && record.location.executionHostId === hostId
    )
    .map((record) => ({ sessionId: record.sessionId, agent: record.provider }))
  return {
    members,
    live: members.filter(
      (session) => observeStructuredWorker({ sessionId: session.sessionId }).status === 'live'
    )
  }
}

/**
 * A count and its providers — never session ids.
 *
 * A session id is one tab-id hop from the random pane key that gates a worker's mailbox, and this
 * string reaches agent-readable CLI output and a desktop toast. The count and the providers are
 * what a user deciding whether to force actually needs; the ids identify nothing they can act on.
 */
function countStructuredSessions(sessions: readonly UnclosedStructuredSession[]): string {
  const noun = sessions.length === 1 ? 'agent session' : 'agent sessions'
  const providers = [...new Set(sessions.map((session) => session.agent))].sort().join(', ')
  return `${sessions.length} ${noun} (${providers})`
}

/**
 * The two post-close verdicts, each with its own count.
 *
 * The split is here for the reason `describeUnstoppedPtys` carries one: "we watched it stay
 * attached" and "we could not confirm it went" are different decisions to waive, and the delete
 * toast branches on the marker a proven-live session leads with.
 *
 * Both groups are named, though, which is where this differs from the PTY sibling: there, the
 * verdict is a fresh inventory, so anything absent from the live list is PROVEN exited and
 * rightly dropped. Here an `unverifiable` session is unclosed too — folding it into the live
 * count would overstate what Orca watched, and dropping it said "1 agent session" while three
 * were about to be discarded.
 */
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

/**
 * What the close loop has done so far, readable while it is still running.
 *
 * The loop is serial and every close waits on a provider round trip, so the shared sweep budget can
 * expire part-way through it. This is written as it goes rather than returned at the end, because
 * the caller's timeout path reads THIS: a fabricated whole-list fallback reported sessions the
 * sweep had already closed as unclosed, named them in the refusal the user reads, and logged
 * `structured=0` for closes that landed. Saying only what was observed is the point of the sweep.
 */
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

/**
 * Everything this sweep did not prove closed.
 *
 * A session with no recorded outcome — never started, or still in flight — reports `unverifiable`,
 * the same verdict as an attempted close that stayed unproven. Chosen, not conflated: the vocabulary is `live` / `unverifiable` / `exited` with no
 * synonyms, and "we never asked" and "we asked and could not confirm" are both exactly "not
 * observed exited". A fourth bucket would need its own refusal wording and its own toast
 * classification for a distinction the user cannot act on any differently — and `live` is the only
 * verdict either could be mistaken for, which is the one thing neither is allowed to claim.
 */
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

/**
 * Closes the structured sessions in `progress`, recording what stayed as it goes.
 *
 * Runs on the ordinary removal too, not just force: a child left running against a deleted `cwd` is
 * the outcome this whole sweep exists to prevent, and closing is how you prevent it. What stayed is
 * the only thing worth refusing over.
 *
 * Takes the list rather than re-deriving it, so the refusal can only ever name a session out of
 * the set this sweep was handed — re-enumerating would run every liveness observation twice and
 * let it name one this call never touched. Not every one of them is a session a close was
 * attempted on: the deadline check below can leave the tail of the list unasked, and
 * `unclosedStructuredSessions` reports those as `unverifiable` precisely because nobody looked.
 */
export async function closeStructuredSessionsForWorktree(
  progress: StructuredSweepProgress,
  deadline: number,
  options: {
    runtime?: StructuredWorktreeSweepRuntime
    /**
     * Whether this removal can still refuse over an unclosed session.
     *
     * It is the only case where the workspace — and therefore its chat tabs — survives, so it is
     * the only case where an unproven close may put a tab back. Force and the folder-workspace
     * paths discard the workspace whatever the sweep reports.
     */
    mayRefuse?: boolean
  } = {}
): Promise<void> {
  const { runtime, mayRefuse } = options
  // No `afterClose` for a dispatched worker: `host.close` drops the holds, so nothing keeps a
  // provider child un-evictable, but the dispatch's redrive subscription and registry entry do
  // survive until it settles by another verb. That is a bounded leak, not a hazard — and passing
  // one here would mean resolving a dispatch id per session on a teardown path that must stay
  // inside the sweep deadline.
  for (const session of progress.sessions) {
    // Stops ISSUING new closes once the budget is spent; an in-flight one is left to finish, since
    // nothing here can cancel a provider round trip. Without this, one slow round trip starved
    // every session behind it: the caller's race had already given up, and the loop went on
    // closing sessions whose outcome nobody would read.
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
      // Re-observed rather than reusing the close's own reason string: what the user is asked to
      // waive is the state AFTER the attempt, and a close that threw never reached an observation.
      const status = observeStructuredWorker({ sessionId: session.sessionId }).status
      if (status === 'exited') {
        // The re-read can PROVE the exit a failed close could not — it threw past its own
        // observation, or the record's death evidence landed after it read. Refusing on a child
        // that is demonstrably gone is the defect this sweep exists to remove, so take the proof
        // and run the retirement `closeStructuredAgentSessionChild` skipped when it gave up.
        //
        // Including the hide it UNDID: its rollback ran against an observation taken one store
        // write before this one, so a child that died in between left the tab republished for a
        // session this sweep is about to count closed. Taking the proof has to take that back.
        await dropDurableChatTabReference(session.sessionId)
        retireSettledStructuredWorkerTab(session.sessionId, runtime)
        progress.closed += 1
      } else {
        progress.unstopped.push({ ...session, status })
      }
    }
    // Advanced only once an outcome is recorded, so a close still in flight when the deadline
    // lands stays reported as unclosed instead of falling out of both counts.
    progress.settled += 1
  }
}

/**
 * Retires the chat tabs of every structured session in a workspace this removal is discarding.
 *
 * The close path already does this for a session it CLOSED. This is the complement: the members
 * with no attached child, which the close list never contained and nothing else will hide. Their
 * durable reference survives every purge a removal already performs: the renderer drops `unifiedTabsByWorktree` and the main
 * process drops the workspace metadata, and neither touches `visibleSessionIds`. Startup replays
 * that index, restores the session from it and republishes the tab, so the chat comes back at the
 * next launch pointing at a workspace that is gone. Worktree ids are path-derived and can be
 * recreated, so a later workspace at the same path inherits the tab — which is the hazard
 * `removeWorktreeMetadataAndHistory` purges everything else to prevent.
 *
 * The caller owns WHEN: this must only be reached once the removal can no longer refuse, because
 * a refusal leaves the workspace and its tabs in place. Same reasoning as the close's own
 * `restoreTabOnUnprovenClose` gate, one level up.
 *
 * Serial, and structurally unable to fail the teardown: each step is a store transaction that
 * serializes per session anyway, and a removal must not be turned back by tab bookkeeping.
 */
export async function retireStructuredSessionTabsForWorktree(
  sessions: readonly StructuredSessionInWorkspace[],
  runtime?: StructuredWorktreeSweepRuntime
): Promise<void> {
  for (const session of sessions) {
    await dropDurableChatTabReference(session.sessionId)
    retireSettledStructuredWorkerTab(session.sessionId, runtime)
  }
}

/**
 * Drops a settled session's durable chat-tab reference, and cannot fail the settlement.
 *
 * The close's own hide is the ordinary path; this is only for the session whose exit this sweep
 * proved after that close had already rolled the hide back.
 */
async function dropDurableChatTabReference(sessionId: string): Promise<void> {
  try {
    await getStructuredAgentSessionHost()?.setSessionTabVisibility?.(sessionId, false)
  } catch (error) {
    console.warn(
      `[worktree-teardown] could not drop the chat tab reference for ${sessionId}`,
      error
    )
  }
}
