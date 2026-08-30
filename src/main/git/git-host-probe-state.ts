/**
 * The retained per-host state behind `git-host-probe-breaker`, plus the rules
 * for forgetting it.
 *
 * Why separate: retention is where this can fail silently. An open breaker is
 * the *oldest* surviving entry — a healthy host is deleted the moment its last
 * probe releases and re-inserted at the end — so an eviction pass that walks
 * insertion order drops exactly the state that is holding a storm back.
 */

export type GitProbeSlot = { admittedAtMs: number }

export type GitProbeHostState = {
  consecutiveUnavailable: number
  lastUnavailableAtMs: number
  openCount: number
  blockedUntilMs: number
  inFlight: Set<GitProbeSlot>
  queued: number
  waiters: (() => void)[]
  reportedOpen: boolean
}

/** Reconnect churn mints a key per SSH generation, so bound retained hosts. */
export const MAX_TRACKED_GIT_PROBE_HOSTS = 64

export const gitProbeHostStates = new Map<string, GitProbeHostState>()

function isIdleGitProbeHost(state: GitProbeHostState): boolean {
  return state.inFlight.size === 0 && state.queued === 0 && state.waiters.length === 0
}

export function isForgettableGitProbeHost(state: GitProbeHostState): boolean {
  return (
    isIdleGitProbeHost(state) && state.consecutiveUnavailable === 0 && state.blockedUntilMs === 0
  )
}

/**
 * Why: every relay flap mints `ssh:<id>:<generation+1>`, and a flap that left
 * one failed probe behind leaves a permanently unforgettable entry. Retiring the
 * older generations of the same connection removes the map's only growth source,
 * so churn cannot crowd out a host that is actually wedged.
 */
export function forgetRetiredSshGitProbeGenerations(hostKey: string): void {
  const generationAt = hostKey.lastIndexOf(':')
  if (!hostKey.startsWith('ssh:') || generationAt <= 'ssh'.length) {
    return
  }
  const connectionPrefix = hostKey.slice(0, generationAt + 1)
  for (const [key, state] of gitProbeHostStates) {
    // Why the digit test: a connection id may itself contain `:`, so a prefix
    // match alone would let `ssh:a:0` retire the unrelated host `ssh:a:b:0`.
    if (
      key !== hostKey &&
      key.startsWith(connectionPrefix) &&
      /^\d+$/.test(key.slice(connectionPrefix.length)) &&
      isIdleGitProbeHost(state)
    ) {
      gitProbeHostStates.delete(key)
    }
  }
}

/**
 * Drops the least informative entries first: a host with nothing to remember,
 * then one whose cooldown has already lapsed. Only when every tracked host is
 * mid-outage does this fall back to dropping one that is still cooling down —
 * bounded memory has to win somewhere, and there the re-probe is one host wide.
 */
export function evictIdleGitProbeHostStates(now: number = Date.now()): void {
  if (gitProbeHostStates.size <= MAX_TRACKED_GIT_PROBE_HOSTS) {
    return
  }
  evictWhere((state) => state.consecutiveUnavailable === 0 && state.blockedUntilMs === 0)
  evictWhere((state) => state.blockedUntilMs <= now)
  evictWhere(() => true)
}

function evictWhere(shouldEvict: (state: GitProbeHostState) => boolean): void {
  for (const [key, state] of gitProbeHostStates) {
    if (gitProbeHostStates.size <= MAX_TRACKED_GIT_PROBE_HOSTS) {
      return
    }
    // Why never a live entry: its release would orphan the slot accounting.
    if (isIdleGitProbeHost(state) && shouldEvict(state)) {
      gitProbeHostStates.delete(key)
    }
  }
}
