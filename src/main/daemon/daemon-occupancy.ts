import { DaemonClient } from './client'
import { inspectDaemonPtyOwnership } from './daemon-live-pty-evidence'
import { PROTOCOL_VERSION, type ListSessionsResult } from './types'

/**
 * How much work a daemon is hosting, and how sure we are.
 *
 * The distinction that matters: only the daemon itself can prove it is *empty*.
 * The OS process table can prove work exists, but a table that shows nothing may
 * simply have failed to observe it — so it may only ever add protection, never
 * license a kill. 'unknown' is the residual, and it is not permission.
 */
export type DaemonOccupancy =
  | { state: 'occupied'; liveSessions: number | null }
  | { state: 'empty'; liveSessions: 0 }
  | { state: 'unknown'; liveSessions: null }

export type DaemonOccupancyDeps = {
  listSessions?: (
    socketPath: string,
    tokenPath: string,
    budgetMs: number,
    connectBudgetMs: number
  ) => Promise<number | null>
  inspectPtyOwnership?: typeof inspectDaemonPtyOwnership
}

/**
 * Why two budgets, not one: connecting and answering fail for different reasons and deserve
 * different patience. A daemon that cannot complete a handshake is wedged, and asking again
 * shortly is the cheap way to find out whether it recovers — so connect stays tight and the
 * caller retries it. A daemon that *did* answer the handshake is demonstrably alive, and its
 * session count is the one thing that settles the question outright, so it is worth waiting
 * for. Collapsing both into one tight budget is what made a slow-but-answering daemon
 * indistinguishable from a dead one, and got its agents killed.
 */
export const OCCUPANCY_CONNECT_BUDGET_MS = 4_000
export const OCCUPANCY_REQUEST_BUDGET_MS = 15_000

/**
 * Live session count over the daemon's own socket; null when it could not answer.
 * `budgetMs` caps the whole exchange, so a caller working to a deadline can hand over what
 * it has left rather than trusting a constant to still fit.
 */
async function countLiveSessionsOverIpc(
  socketPath: string,
  tokenPath: string,
  budgetMs: number,
  connectBudgetMs: number
): Promise<number | null> {
  const client = new DaemonClient({ socketPath, tokenPath, protocolVersion: PROTOCOL_VERSION })
  const deadline = Date.now() + budgetMs
  const remaining = (): number => Math.max(1, deadline - Date.now())
  try {
    await client.ensureConnectedWithin(Math.min(connectBudgetMs, remaining()))
    const result = await client.request<ListSessionsResult>(
      'listSessions',
      undefined,
      Math.min(OCCUPANCY_REQUEST_BUDGET_MS, remaining())
    )
    return result.sessions.filter((session) => session.isAlive).length
  } catch {
    return null
  } finally {
    client.disconnect()
  }
}

/**
 * Ask the daemon first — a reply is authoritative both ways. Only when it cannot
 * answer do we fall back to the process table, and then only to *raise* the answer
 * to 'occupied'. A blind or empty-looking table stays 'unknown', because a daemon
 * too wedged to list its sessions is exactly as likely to be hosting them.
 *
 * `recordedPid` must already be identity-verified, or the evidence could describe
 * a recycled pid's children rather than this daemon's terminals.
 */
export async function resolveDaemonOccupancy(args: {
  socketPath: string
  tokenPath: string
  recordedPid: number | null
  /** Ceiling for the whole resolution; defaults to the connect plus request budgets. */
  budgetMs?: number
  /**
   * How long to spend on the handshake alone. Defaults to the cheap ask. A caller that has
   * budget left and no answer yet should raise it: retrying a four-second handshake twelve
   * times cannot reach a daemon that consistently needs five, and this path is only reached
   * because a three-second health check already timed out — so re-asking on a stricter budget
   * than the one that triaged it here can only ever agree with it.
   */
  connectBudgetMs?: number
  deps?: DaemonOccupancyDeps
}): Promise<DaemonOccupancy> {
  const { socketPath, tokenPath, recordedPid, deps = {} } = args
  const budgetMs = args.budgetMs ?? OCCUPANCY_CONNECT_BUDGET_MS + OCCUPANCY_REQUEST_BUDGET_MS
  const connectBudgetMs = args.connectBudgetMs ?? OCCUPANCY_CONNECT_BUDGET_MS
  const unknown: DaemonOccupancy = { state: 'unknown', liveSessions: null }
  // Why catch rather than let it propagate: 'unknown' is this module's residual, and a
  // question that could not be asked is the residual's whole purpose. An escaping throw
  // would route a failed observation into the launch path instead.
  try {
    const counted = await (deps.listSessions ?? countLiveSessionsOverIpc)(
      socketPath,
      tokenPath,
      budgetMs,
      connectBudgetMs
    )
    if (counted !== null) {
      // Why validate a number we just asked for: 'empty' is the one verdict that licenses a
      // kill, and `counted > 0` quietly reads NaN, -1 and every other non-count as emptiness.
      // The dep is injectable, so that is reachable without the daemon ever being asked.
      if (!Number.isInteger(counted) || counted < 0) {
        return unknown
      }
      return counted > 0
        ? { state: 'occupied', liveSessions: counted }
        : { state: 'empty', liveSessions: 0 }
    }
    if (recordedPid === null) {
      return unknown
    }
    const ownership = await (deps.inspectPtyOwnership ?? inspectDaemonPtyOwnership)(recordedPid)
    return ownership === 'owns-live-ptys' ? { state: 'occupied', liveSessions: null } : unknown
  } catch {
    return unknown
  }
}

/**
 * Raise an unanswered verdict with out-of-band evidence. It can only ever raise: an
 * absent or unreadable process table leaves the verdict exactly as it was, because the
 * table can prove work exists and never that it does not.
 *
 * Separate from the IPC path so a caller waiting for the daemon to recover can re-ask it
 * cheaply, and pay for the process table once, after the waiting is done.
 */
export async function raiseOccupancyWithProcessEvidence(
  occupancy: DaemonOccupancy,
  recordedPid: number | null,
  deps: DaemonOccupancyDeps = {}
): Promise<DaemonOccupancy> {
  if (occupancy.state !== 'unknown' || recordedPid === null) {
    return occupancy
  }
  try {
    const ownership = await (deps.inspectPtyOwnership ?? inspectDaemonPtyOwnership)(recordedPid)
    return ownership === 'owns-live-ptys' ? { state: 'occupied', liveSessions: null } : occupancy
  } catch {
    return occupancy
  }
}
