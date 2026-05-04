const liveClaudePtyIds = new Set<string>()
let switchInProgress = false

export function markClaudePtySpawned(ptyId: string): void {
  liveClaudePtyIds.add(ptyId)
}

export function markClaudePtyExited(ptyId: string): void {
  liveClaudePtyIds.delete(ptyId)
}

export function beginClaudeAuthSwitch(): void {
  if (switchInProgress) {
    throw new Error('A Claude account switch is already in progress.')
  }
  if (liveClaudePtyIds.size > 0) {
    throw new Error('Close or restart live Claude terminals before switching Claude accounts.')
  }
  switchInProgress = true
}

export function endClaudeAuthSwitch(): void {
  switchInProgress = false
}

export function isClaudeAuthSwitchInProgress(): boolean {
  return switchInProgress
}
