const liveClaudePtyIds = new Set<string>()
// Why: ids restored from persistence at startup, not yet confirmed against the
// daemon. They keep the OAuth refresh gate closed so an early managed refresh
// cannot rotate the single-use refresh token out from under a Claude CLI that
// survived the app restart inside the daemon.
const seededUnconfirmedPtyIds = new Set<string>()
let switchInProgress = false
// Woken by endClaudeAuthSwitch so a caller past the point of no return can wait the
// swap out instead of refusing. See whenClaudeAuthSwitchSettles.
const switchSettledListeners = new Set<() => void>()

/** A managed account swap is a credential-file rewrite, not a network round trip;
 *  anything past this is a wedged switch, and refusing beats waiting forever. */
export const CLAUDE_AUTH_SWITCH_SETTLE_TIMEOUT_MS = 15_000

export type ClaudeLivePtyPersistence = {
  addClaudeLivePtySessionId(sessionId: string): void
  removeClaudeLivePtySessionId(sessionId: string): void
}

let persistence: ClaudeLivePtyPersistence | null = null

export function attachClaudeLivePtyPersistence(target: ClaudeLivePtyPersistence | null): void {
  persistence = target
}

// Why: a live claude defers the managed OAuth refresh ("Waiting for Claude
// session"); consumers need the 1 -> 0 transition to recover promptly instead
// of waiting out the usage-fetch failure backoff.
type LiveClaudePtyDrainListener = () => void
const drainListeners = new Set<LiveClaudePtyDrainListener>()

export function onLiveClaudePtysDrained(listener: LiveClaudePtyDrainListener): () => void {
  drainListeners.add(listener)
  return () => drainListeners.delete(listener)
}

function notifyDrainedOnTransition(hadLivePtys: boolean): void {
  if (!hadLivePtys || liveClaudePtyIds.size > 0) {
    return
  }
  for (const listener of drainListeners) {
    listener()
  }
}

export function seedLiveClaudePtysFromPersistence(sessionIds: readonly string[]): void {
  for (const sessionId of sessionIds) {
    liveClaudePtyIds.add(sessionId)
    seededUnconfirmedPtyIds.add(sessionId)
  }
}

export function hasSeededUnconfirmedClaudePtys(): boolean {
  return seededUnconfirmedPtyIds.size > 0
}

/**
 * Reconcile seeded ids against the daemon's live session list. Seeded ids the
 * daemon no longer knows are dead — release them so they cannot defer OAuth
 * refresh forever. Seeded ids that are still alive stay in the gate even if
 * their pane never reattaches: that daemon process still owns the credentials.
 */
export function confirmSeededClaudeLivePtys(aliveSessionIds: readonly string[]): void {
  const hadLivePtys = liveClaudePtyIds.size > 0
  const alive = new Set(aliveSessionIds)
  for (const sessionId of seededUnconfirmedPtyIds) {
    if (!alive.has(sessionId)) {
      liveClaudePtyIds.delete(sessionId)
      persistence?.removeClaudeLivePtySessionId(sessionId)
    }
  }
  seededUnconfirmedPtyIds.clear()
  notifyDrainedOnTransition(hadLivePtys)
}

export function markClaudePtySpawned(ptyId: string): void {
  liveClaudePtyIds.add(ptyId)
  seededUnconfirmedPtyIds.delete(ptyId)
  persistence?.addClaudeLivePtySessionId(ptyId)
}

export function markClaudePtyExited(ptyId: string): void {
  const hadLivePtys = liveClaudePtyIds.size > 0
  liveClaudePtyIds.delete(ptyId)
  seededUnconfirmedPtyIds.delete(ptyId)
  persistence?.removeClaudeLivePtySessionId(ptyId)
  notifyDrainedOnTransition(hadLivePtys)
}

/**
 * Register a structured Claude child with the same gate the terminal path uses.
 *
 * The gate is what makes the managed OAuth refresh defer instead of rotating a
 * single-use refresh token out from under a running Claude (runtime-auth-sync.ts).
 * A structured session's child is as much a live Claude as a PTY's is, so it has to
 * hold the gate too — otherwise a refresh mid-turn breaks its next API call while an
 * identical terminal session is protected.
 *
 * Deliberately not persisted, unlike markClaudePtySpawned: these children are direct
 * children of this process and cannot survive a restart, so seeding them back on the
 * next launch would hold the gate closed for a process that is provably gone.
 */
export function markClaudeStructuredChildSpawned(childKey: string): void {
  liveClaudePtyIds.add(structuredChildGateId(childKey))
}

export function markClaudeStructuredChildExited(childKey: string): void {
  const hadLivePtys = liveClaudePtyIds.size > 0
  liveClaudePtyIds.delete(structuredChildGateId(childKey))
  notifyDrainedOnTransition(hadLivePtys)
}

// Namespaced so a structured child can never collide with a daemon PTY session id,
// which confirmSeededClaudeLivePtys reconciles against the daemon's own list.
function structuredChildGateId(childKey: string): string {
  return `claude-structured:${childKey}`
}

export function hasLiveClaudePtys(): boolean {
  return liveClaudePtyIds.size > 0
}

export function beginClaudeAuthSwitch(): void {
  if (switchInProgress) {
    throw new Error('A Claude account switch is already in progress.')
  }
  switchInProgress = true
}

export function endClaudeAuthSwitch(): void {
  const wasInProgress = switchInProgress
  switchInProgress = false
  if (!wasInProgress) {
    return
  }
  // Each listener removes itself as it settles; Set iteration is defined over that.
  for (const listener of switchSettledListeners) {
    listener()
  }
}

/**
 * Resolves `true` once no account switch is running, `false` if one is still running
 * at the deadline.
 *
 * Exists for callers that have already done irreversible work — a structured acquire
 * has closed the old child by the time it resolves its launch, so turning a switch
 * into a refusal there strands the user with a dead session and no replacement.
 * Waiting for the swap and then launching against it is the recoverable answer;
 * refusing is only correct when nothing has been torn down yet.
 */
export function whenClaudeAuthSwitchSettles(
  timeoutMs = CLAUDE_AUTH_SWITCH_SETTLE_TIMEOUT_MS
): Promise<boolean> {
  if (!switchInProgress) {
    return Promise.resolve(true)
  }
  return new Promise<boolean>((resolve) => {
    const settle = (settled: boolean): void => {
      switchSettledListeners.delete(listener)
      clearTimeout(timer)
      resolve(settled)
    }
    const listener = (): void => settle(true)
    switchSettledListeners.add(listener)
    const timer = setTimeout(() => settle(false), timeoutMs)
    timer.unref?.()
  })
}

export function isClaudeAuthSwitchInProgress(): boolean {
  return switchInProgress
}
