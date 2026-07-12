const liveClaudePtyIds = new Set<string>()
// Why: ids restored from persistence at startup, not yet confirmed against the
// daemon. They keep the OAuth refresh gate closed so an early managed refresh
// cannot rotate the single-use refresh token out from under a Claude CLI that
// survived the app restart inside the daemon.
const seededUnconfirmedPtyIds = new Set<string>()
let switchInProgress = false

export type ClaudeLivePtyPersistence = {
  addClaudeLivePtySessionId(sessionId: string): void
  removeClaudeLivePtySessionId(sessionId: string): void
}

let persistence: ClaudeLivePtyPersistence | null = null

export function attachClaudeLivePtyPersistence(target: ClaudeLivePtyPersistence | null): void {
  persistence = target
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
  const alive = new Set(aliveSessionIds)
  for (const sessionId of seededUnconfirmedPtyIds) {
    if (!alive.has(sessionId)) {
      liveClaudePtyIds.delete(sessionId)
      persistence?.removeClaudeLivePtySessionId(sessionId)
    }
  }
  seededUnconfirmedPtyIds.clear()
}

export function markClaudePtySpawned(ptyId: string): void {
  liveClaudePtyIds.add(ptyId)
  seededUnconfirmedPtyIds.delete(ptyId)
  persistence?.addClaudeLivePtySessionId(ptyId)
}

export function markClaudePtyExited(ptyId: string): void {
  liveClaudePtyIds.delete(ptyId)
  seededUnconfirmedPtyIds.delete(ptyId)
  persistence?.removeClaudeLivePtySessionId(ptyId)
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
  switchInProgress = false
}

export function isClaudeAuthSwitchInProgress(): boolean {
  return switchInProgress
}
