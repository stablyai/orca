import {
  recordCoalescedDurableCrashBreadcrumb,
  recordDurableCrashBreadcrumb
} from '../crash-reporting/durable-crash-breadcrumb'
import {
  evictIdleGitProbeHostStates,
  forgetRetiredSshGitProbeGenerations,
  gitProbeHostStates as hostStates,
  isForgettableGitProbeHost,
  type GitProbeHostState,
  type GitProbeSlot
} from './git-host-probe-state'

/**
 * Per-host admission control for the git host probes behind forge detection
 * (crash f2521868).
 *
 * Why: the remote-URL probe's deadline makes a wedged call *settle* rather than
 * hang, so the in-flight coalescer drops its entry and the very next poll
 * re-issues — at whatever concurrency the pollers happen to have. In the
 * reported hour that was 431 calls, 414 of them dying on the deadline, peaking
 * at 15 concurrent `wsl.exe` children whose contention stretched a 30s deadline
 * into a 120s span, so the storm fed itself and never recovered. Nothing here
 * changes how a probe is run; it decides how hard a host that is not answering
 * may still be pushed, and it always keeps a way back.
 *
 * State is scoped to the host that executes git — the native host, one WSL
 * distro, one SSH connection generation — so a dead distro can never gate the
 * repos of a host that is fine.
 */

/**
 * One unanswered probe is a blip: a cold WSL interop call, a dropped relay
 * frame. Two means the host has spent a minute answering nothing, so stop
 * fanning out. Three means it is wedged, and probing it on demand only feeds
 * the loop. Tripping any earlier would punish WSL's genuinely slow cold start,
 * which is exactly when a user opening Orca deserves a real answer.
 */
export const GIT_HOST_PROBE_SERIALIZE_AFTER = 2
export const GIT_HOST_PROBE_OPEN_AFTER = 3

/**
 * The incident peaked at 15 concurrent children, so a ceiling only bounds
 * anything if it sits under that. A burst wider than this queues rather than
 * fails — on a healthy host each probe is a sub-second config read, so the
 * waves cost far less than one contended spawn. A degraded host gets one slot.
 */
export const GIT_HOST_PROBE_HEALTHY_CONCURRENCY = 8

/**
 * A probe costs one full deadline, so retrying sooner than that spends more
 * wall time inside the host than outside it. The ceiling is the longest span a
 * single wedged call was observed to hold the host: past that, waiting longer
 * buys no further idle time and only delays an unattended recovery.
 */
export const GIT_HOST_PROBE_BASE_COOLDOWN_MS = 30_000
export const GIT_HOST_PROBE_MAX_COOLDOWN_MS = 120_000

/**
 * Every guarded probe carries its own deadline, but nothing here can prove it,
 * and at the degraded ceiling of one slot a probe that never settled would
 * block its host for the life of the process — the exact defect
 * `coalesced-probe.ts` already had to fix once. Reclaim a slot past the longest
 * a single guarded region can legitimately run: a 5s routing probe, a 30s
 * deadline, and a 30s direct-WSL fallback retry, with room to spare.
 */
export const GIT_HOST_PROBE_SLOT_STALE_MS = 180_000

/**
 * "Consecutive" has to mean "within one episode". Two deadline kills either
 * side of a laptop suspend say nothing about the host now, and with no decay
 * they would pin it at the degraded ceiling until some probe ran alone. Sized
 * like the cooldown cap: past one full backoff interval a stale blip has had
 * every chance to repeat.
 */
export const GIT_HOST_PROBE_STREAK_DECAY_MS = 120_000

/** Past this a *failing* host's backlog is pathological; shed rather than buffer it. */
const MAX_QUEUED_PER_FAILING_HOST = 64
/** A two-hour outage must still be legible in a 30-entry breadcrumb ring. */
const STILL_OPEN_BREADCRUMB_INTERVAL_MS = 5 * 60_000
/** Keeps `2 ** openCount` away from Infinity on a host down for days. */
const MAX_COOLDOWN_DOUBLINGS = 20

type BlockReason = 'cooling-down' | 'trial-outstanding' | 'queue-full'

type Admission =
  | { kind: 'admitted'; slot: GitProbeSlot; halfOpen: boolean }
  | { kind: 'blocked'; reason: BlockReason }
  | { kind: 'queue' }

export type GitHostProbeBlockedError = Error & { gitHostProbeBlocked: true }

export type GitProbeHostParts = {
  connectionId?: string | null
  connectionGeneration?: number
  wslDistro?: string
}

/** Scopes probe state to the runtime that actually executes git. */
export function gitProbeHostKey(parts: GitProbeHostParts): string {
  if (parts.connectionId) {
    // Why: a reconnect retires the failing transport, so the new generation is a
    // new key and starts trusted instead of serving out the old one's cooldown.
    return `ssh:${parts.connectionId}:${parts.connectionGeneration ?? 0}`
  }
  // Why lowercased: wsl.exe matches distro names case-insensitively, so a UNC
  // path spelled `ubuntu` and a hint spelled `Ubuntu` are one host and must
  // share one budget rather than splitting it into two half-blind ones.
  return parts.wslDistro ? `wsl:${parts.wslDistro.toLowerCase()}` : 'native'
}

export function isGitHostProbeBlockedError(error: unknown): error is GitHostProbeBlockedError {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { gitHostProbeBlocked?: unknown }).gitHostProbeBlocked === true
  )
}

/**
 * Runs `probe` under this host's failure budget. `isUnavailableError` decides
 * which rejections are the host failing to answer — anything else, including a
 * repo saying it has no such remote, is proof the host is alive and clears the
 * budget. Rejects without running `probe` when the host is being backed off.
 */
export async function runGuardedGitHostProbe<T>(
  hostKey: string,
  probe: () => Promise<T>,
  isUnavailableError: (error: unknown) => boolean
): Promise<T> {
  const state = getHostState(hostKey)
  const { slot, halfOpen } = await admit(hostKey, state)
  try {
    const result = await probe()
    recordAnswered(hostKey, state)
    return result
  } catch (error) {
    if (isUnavailableError(error)) {
      recordUnavailable(hostKey, state, halfOpen)
    } else {
      recordAnswered(hostKey, state)
    }
    throw error
  } finally {
    release(hostKey, state, slot)
  }
}

/** Waits for a slot, and reports whether this probe is the trial deciding if the host is back. */
async function admit(
  hostKey: string,
  state: GitProbeHostState
): Promise<{ slot: GitProbeSlot; halfOpen: boolean }> {
  for (;;) {
    const decision = tryAdmit(state)
    if (decision.kind === 'admitted') {
      return decision
    }
    if (decision.kind === 'blocked') {
      throw createBlockedError(hostKey, state, decision.reason)
    }
    // Why: only a host that is already failing gets its backlog bounded. Shedding
    // a caller on a host with a clean budget invents a failure that never
    // happened, and waiters cost nothing but ordering while every slot ahead of
    // them is deadline-bounded.
    if (state.consecutiveUnavailable > 0 && state.queued >= MAX_QUEUED_PER_FAILING_HOST) {
      throw createBlockedError(hostKey, state, 'queue-full')
    }
    state.queued += 1
    try {
      await new Promise<void>((wake) => state.waiters.push(wake))
    } finally {
      state.queued -= 1
    }
  }
}

function tryAdmit(state: GitProbeHostState): Admission {
  const now = Date.now()
  repairClockAnomalies(state, now)
  reclaimStaleSlots(state, now)
  if (state.blockedUntilMs > now) {
    return { kind: 'blocked', reason: 'cooling-down' }
  }
  if (state.blockedUntilMs > 0) {
    // Cooled down: exactly one trial probe gets to decide, alone.
    if (state.inFlight.size > 0) {
      return { kind: 'blocked', reason: 'trial-outstanding' }
    }
    return { kind: 'admitted', slot: occupySlot(state, now), halfOpen: true }
  }
  if (
    state.consecutiveUnavailable > 0 &&
    now - state.lastUnavailableAtMs > GIT_HOST_PROBE_STREAK_DECAY_MS
  ) {
    state.consecutiveUnavailable = 0
  }
  const ceiling =
    state.consecutiveUnavailable >= GIT_HOST_PROBE_SERIALIZE_AFTER
      ? 1
      : GIT_HOST_PROBE_HEALTHY_CONCURRENCY
  if (state.inFlight.size >= ceiling) {
    // Why queue rather than shed: the breaker has not concluded anything yet at
    // this rung, so a synthetic failure here would report a host outage that the
    // very next release may disprove. The wait is bounded — one deadline, after
    // which the host has either answered or opened the breaker.
    return { kind: 'queue' }
  }
  return { kind: 'admitted', slot: occupySlot(state, now), halfOpen: false }
}

/**
 * Why: every deadline here is an absolute wall-clock stamp, so a backwards step
 * — NTP correction, VM snapshot restore, a dual-boot RTC fix — would otherwise
 * strand a host for the length of the jump, far past the documented cap, with
 * no probe admitted to earn the success that is the only way back.
 */
function repairClockAnomalies(state: GitProbeHostState, now: number): void {
  if (state.blockedUntilMs - now > GIT_HOST_PROBE_MAX_COOLDOWN_MS) {
    state.blockedUntilMs = now
  }
  if (state.lastUnavailableAtMs > now) {
    state.lastUnavailableAtMs = now
  }
  for (const slot of state.inFlight) {
    if (slot.admittedAtMs > now) {
      slot.admittedAtMs = now
    }
  }
}

function reclaimStaleSlots(state: GitProbeHostState, now: number): void {
  for (const slot of state.inFlight) {
    if (now - slot.admittedAtMs > GIT_HOST_PROBE_SLOT_STALE_MS) {
      state.inFlight.delete(slot)
    }
  }
}

function occupySlot(state: GitProbeHostState, now: number): GitProbeSlot {
  const slot: GitProbeSlot = { admittedAtMs: now }
  state.inFlight.add(slot)
  return slot
}

function recordAnswered(hostKey: string, state: GitProbeHostState): void {
  const unansweredProbes = state.consecutiveUnavailable
  const wasOpen = state.reportedOpen
  state.consecutiveUnavailable = 0
  state.openCount = 0
  state.blockedUntilMs = 0
  state.reportedOpen = false
  if (wasOpen) {
    recordDurableCrashBreadcrumb('git_host_probe_recovered', { host: hostKey, unansweredProbes })
  }
}

function recordUnavailable(hostKey: string, state: GitProbeHostState, halfOpen: boolean): void {
  state.consecutiveUnavailable += 1
  state.lastUnavailableAtMs = Date.now()
  if (halfOpen) {
    openBreaker(hostKey, state)
    return
  }
  // Why: probes admitted before the breaker opened settle together, and letting
  // each escalate would jump straight to the ceiling on the first failure wave.
  if (state.blockedUntilMs > 0 || state.consecutiveUnavailable < GIT_HOST_PROBE_OPEN_AFTER) {
    return
  }
  openBreaker(hostKey, state)
}

function openBreaker(hostKey: string, state: GitProbeHostState): void {
  state.openCount += 1
  state.blockedUntilMs = Date.now() + cooldownMs(state.openCount)
  const data = {
    host: hostKey,
    unansweredProbes: state.consecutiveUnavailable,
    cooldownMs: state.blockedUntilMs - Date.now()
  }
  if (!state.reportedOpen) {
    state.reportedOpen = true
    recordDurableCrashBreadcrumb('git_host_probe_breaker_open', data)
    return
  }
  recordCoalescedDurableCrashBreadcrumb({
    name: 'git_host_probe_breaker_still_open',
    data,
    coalesceKey: `git-host-probe:${hostKey}`,
    minIntervalMs: STILL_OPEN_BREADCRUMB_INTERVAL_MS
  })
}

function cooldownMs(openCount: number): number {
  const doublings = Math.min(Math.max(0, openCount - 1), MAX_COOLDOWN_DOUBLINGS)
  return Math.min(GIT_HOST_PROBE_BASE_COOLDOWN_MS * 2 ** doublings, GIT_HOST_PROBE_MAX_COOLDOWN_MS)
}

function release(hostKey: string, state: GitProbeHostState, slot: GitProbeSlot): void {
  // Why delete rather than decrement: a slot reclaimed as stale is already gone,
  // and its late release must not hand the host a phantom free slot.
  state.inFlight.delete(slot)
  const waiters = state.waiters.splice(0)
  for (const wake of waiters) {
    wake()
  }
  // Why: a host with nothing left to remember costs nothing to forget, which is
  // what keeps the healthy case from retaining an entry per repo host forever.
  if (hostStates.get(hostKey) === state && isForgettableGitProbeHost(state)) {
    hostStates.delete(hostKey)
  }
}

function createBlockedError(
  hostKey: string,
  state: GitProbeHostState,
  reason: BlockReason
): GitHostProbeBlockedError {
  return Object.assign(new Error(`Git host ${hostKey} ${describeBlock(state, reason)}`), {
    gitHostProbeBlocked: true as const
  })
}

/** Why: this text is the breadcrumb a later triage reads, so it must not claim failures that did not happen. */
function describeBlock(state: GitProbeHostState, reason: BlockReason): string {
  const unanswered = `did not answer ${state.consecutiveUnavailable} consecutive probes`
  if (reason === 'cooling-down') {
    const remainingMs = Math.max(0, state.blockedUntilMs - Date.now())
    return `${unanswered}; suppressed for ~${Math.ceil(remainingMs / 1000)}s.`
  }
  if (reason === 'trial-outstanding') {
    return `${unanswered}; shed while the trial probe deciding whether it is back is outstanding.`
  }
  return `${unanswered} and has ${state.queued} more queued; shed to bound the backlog.`
}

function getHostState(hostKey: string): GitProbeHostState {
  const existing = hostStates.get(hostKey)
  if (existing) {
    return existing
  }
  const state: GitProbeHostState = {
    consecutiveUnavailable: 0,
    lastUnavailableAtMs: 0,
    openCount: 0,
    blockedUntilMs: 0,
    inFlight: new Set(),
    queued: 0,
    waiters: [],
    reportedOpen: false
  }
  forgetRetiredSshGitProbeGenerations(hostKey)
  hostStates.set(hostKey, state)
  evictIdleGitProbeHostStates()
  return state
}

/** @internal — tests only. */
export function _resetGitHostProbeBreaker(): void {
  hostStates.clear()
}

/** @internal — tests only. */
export function _getGitHostProbeState(
  hostKey: string
): { consecutiveUnavailable: number; blockedUntilMs: number; inFlight: number } | null {
  const state = hostStates.get(hostKey)
  return state
    ? {
        consecutiveUnavailable: state.consecutiveUnavailable,
        blockedUntilMs: state.blockedUntilMs,
        inFlight: state.inFlight.size
      }
    : null
}
