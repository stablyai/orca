export type ClaudeSessionMoveStat = {
  strategy: 'resume' | 'proxy'
  rebalance: boolean
  failed: boolean
}

let note: ((stat: ClaudeSessionMoveStat) => void) | null = null

/** The process stats collector installs this. Absent means the move is not counted. */
export function setClaudeSessionMoveStatsRecorder(
  recorder: ((stat: ClaudeSessionMoveStat) => void) | null
): void {
  note = recorder
}

export function noteClaudeSessionMoveStat(stat: ClaudeSessionMoveStat): void {
  note?.(stat)
}
