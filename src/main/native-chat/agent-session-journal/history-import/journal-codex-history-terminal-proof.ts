import type { CodexHistoryRoot } from './journal-codex-history-placement'
import type { CodexThreadItem } from '../../../codex/structured/items/codex-thread-item-identity'

export type CodexHistoryTurnFact = {
  id: string
  root?: CodexHistoryRoot
  complete: boolean
  source: Record<string, unknown>
  userItemId?: string
}
export type CodexHistoryFact = {
  bytes: number
  turn?: CodexHistoryTurnFact
  firstTerminal?: number
  interrupted?: boolean
  turnKey?: string
}
export type CodexHistoryInterruptInterval = { at: number; position: number; turnKey: string }

export function codexHistoryStartupInterrupted(
  item: CodexThreadItem,
  proof: {
    interval: CodexHistoryInterruptInterval | null
    first?: number
    start: unknown
    end: unknown
  }
): boolean {
  const { interval, first, start, end } = proof
  return (
    item.type === 'commandExecution' &&
    item.source === 'unifiedExecStartup' &&
    typeof item.processId === 'string' &&
    item.processId.length > 0 &&
    item.status === 'failed' &&
    item.exitCode === -1 &&
    interval !== null &&
    first !== undefined &&
    first > interval.position &&
    typeof start === 'number' &&
    typeof end === 'number' &&
    Number.isFinite(start) &&
    Number.isFinite(end) &&
    start <= interval.at &&
    interval.at <= end
  )
}
