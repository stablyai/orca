// Split out of nav-ports.ts to keep that file under the line budget (HIGH #2/#3/#6): owns
// HudState.askInteraction's phase transitions, the host/prompt-identity ownership guard, and the
// bounded confirmation poll that follows an accepted terminal.send — so nav-ports.ts's
// sendAskAnswer stays focused on resolving the waiting terminal and sending to it.
import type { RpcSuccess } from '../transport/orca-rpc-wire'
import type { AskInteraction, HudState, HudStore } from '../state/hud-store'
import { currentAsk } from '../state/notification-inbox-state'
import type { ActiveHostSession, HostSessionManager } from './host-session-manager'

/** Injectable so tests can drive the bounded confirmation poll deterministically — `now()` lets
 *  a fake clock advance in lockstep with scheduled ticks instead of racing real wall-clock time
 *  against a synchronous test body. */
export type NavPortsTimer = {
  setTimeout(cb: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
  now(): number
}

export const REAL_TIMER: NavPortsTimer = {
  setTimeout: (cb, ms) => setTimeout(cb, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => Date.now()
}

export type AskPhase = NonNullable<AskInteraction>['phase']

/** Phases in which a repeat send for the SAME prompt must be blocked (CRITICAL #11) — shared by
 *  nav-context.ts's askSendInFlight so the two never drift apart (HIGH #3). 'stalled' is
 *  included: the keystrokes were already accepted, so a retry would risk a duplicate answer
 *  rather than recover anything. */
export const ASK_RETRY_BLOCKED_PHASES: ReadonlySet<AskPhase> = new Set([
  'sending',
  'checking',
  'unresolved',
  'stalled'
])

export function setAskPhase(
  store: HudStore,
  hostId: string,
  notificationId: string,
  worktreeId: string,
  phase: AskPhase
): void {
  store.update((s) => ({
    ...s,
    askInteraction: { hostId, notificationId, worktreeId, phase, updatedAt: Date.now() }
  }))
}

/** HIGH #3: true when nothing has since claimed the interaction slot for a DIFFERENT host/prompt
 *  — an old call's post-await continuation must never clobber a newer prompt's/host's phase. */
export function ownsAskInteraction(
  state: HudState,
  hostId: string,
  notificationId: string
): boolean {
  const interaction = state.askInteraction
  return (
    interaction === null ||
    (interaction.hostId === hostId && interaction.notificationId === notificationId)
  )
}

/** HIGH #2: ground truth for "is this the exact prompt we were asked to answer, still live" —
 *  the wearer's connected host hasn't changed, currentAsk() still names this exact
 *  host/worktree/notificationId (not a retired tombstone, not a newer episode), and the
 *  worktree is still actually `permission`. Re-checked after every async gap in sendAskAnswer so
 *  a prompt that expired mid-resolution can never have its keystrokes routed to whatever the ask
 *  became afterward. */
export function isAskStillLive(
  state: HudState,
  hostId: string,
  worktreeId: string,
  notificationId: string
): boolean {
  if (state.connection.hostId !== hostId) {
    return false
  }
  const ask = currentAsk(state)
  if (!ask || ask.notificationId !== notificationId || ask.worktreeId !== worktreeId) {
    return false
  }
  const row = state.dashboard.rows.find((r) => r.worktreeId === worktreeId)
  return row?.status === 'permission'
}

type WorktreePsStatusResult = { worktrees?: { worktreeId: string; status?: string }[] }

/** Direct, awaitable `worktree.ps` read for the confirmation poll (HIGH #6) — bypassing
 *  `dashboard.refreshNow()` (fire-and-forget) so each tick can await its own RPC before ever
 *  scheduling the next one, instead of guessing whether a fixed delay outlasted the RPC. */
async function fetchWorktreeStatus(
  session: ActiveHostSession,
  worktreeId: string
): Promise<'permission' | 'cleared' | 'unverifiable'> {
  try {
    const response = await session.client.sendRequest('worktree.ps', {})
    if (!response.ok) {
      return 'unverifiable'
    }
    const rows = ((response as RpcSuccess).result as WorktreePsStatusResult).worktrees ?? []
    const row = rows.find((r) => r.worktreeId === worktreeId)
    if (row === undefined) {
      return 'unverifiable'
    }
    return row.status === 'permission' ? 'permission' : 'cleared'
  } catch {
    return 'unverifiable'
  }
}

const CONFIRMATION_POLL_INTERVAL_MS = 300
// Bounded elapsed deadline (HIGH #6), not an attempt count — the poll always awaits the previous
// tick's RPC before scheduling the next, so this is a true wall-clock (fake-clock in tests) bound
// rather than a proxy for "N ticks happened".
export const CONFIRMATION_POLL_DEADLINE_MS = 1500

export type AskPollDeps = {
  store: HudStore
  sessions: HostSessionManager
  timer?: NavPortsTimer
}

export function scheduleConfirmationPoll(
  deps: AskPollDeps,
  session: ActiveHostSession,
  hostId: string,
  notificationId: string,
  worktreeId: string,
  deadlineAt: number
): void {
  const timer = deps.timer ?? REAL_TIMER
  timer.setTimeout(() => {
    void runConfirmationTick(deps, session, hostId, notificationId, worktreeId, deadlineAt)
  }, CONFIRMATION_POLL_INTERVAL_MS)
}

/** Single non-overlapping poll step (HIGH #6): schedules itself again only AFTER its own
 *  `worktree.ps` read resolves, so two reads for the same ask are never in flight at once. */
async function runConfirmationTick(
  deps: AskPollDeps,
  session: ActiveHostSession,
  hostId: string,
  notificationId: string,
  worktreeId: string,
  deadlineAt: number
): Promise<void> {
  if (deps.sessions.current() !== session) {
    return // host switched mid-poll — a fresher session (if any) owns this worktree's state
  }
  const interaction = deps.store.getState().askInteraction
  if (
    !interaction ||
    interaction.hostId !== hostId ||
    interaction.notificationId !== notificationId ||
    interaction.phase !== 'checking'
  ) {
    return // superseded: answered another way, a new send started, or the wearer moved on
  }

  session.dashboard.refreshNow() // best-effort UI sync; the verdict below never depends on it
  const status = await fetchWorktreeStatus(session, worktreeId)
  const timer = deps.timer ?? REAL_TIMER
  if (
    deps.sessions.current() !== session ||
    !ownsAskInteraction(deps.store.getState(), hostId, notificationId)
  ) {
    return
  }
  if (status === 'cleared') {
    setAskPhase(deps.store, hostId, notificationId, worktreeId, 'answered')
    return
  }
  if (timer.now() >= deadlineAt) {
    // Recoverable, not a permanent dead end (HIGH #6): reconcileStalledAskInteraction below
    // flips this to 'answered' the moment a LATER dashboard refresh shows it actually cleared.
    setAskPhase(deps.store, hostId, notificationId, worktreeId, 'stalled')
    return
  }
  scheduleConfirmationPoll(deps, session, hostId, notificationId, worktreeId, deadlineAt)
}

/** HIGH #6 reconciliation: a 'stalled' interaction is never a final verdict — the next time ANY
 *  dashboard refresh (the ambient 5s poll, foregroundEnter, a fresh sendAskAnswer's own
 *  refreshNow) shows the worktree actually left `permission`, this flips it to 'answered'. */
export function reconcileStalledAskInteraction(store: HudStore): void {
  const state = store.getState()
  const interaction = state.askInteraction
  if (
    !interaction ||
    interaction.phase !== 'stalled' ||
    interaction.hostId !== state.connection.hostId
  ) {
    return
  }
  const row = state.dashboard.rows.find((r) => r.worktreeId === interaction.worktreeId)
  if (row !== undefined && row.status !== 'permission') {
    setAskPhase(
      store,
      interaction.hostId,
      interaction.notificationId,
      interaction.worktreeId,
      'answered'
    )
  }
}
