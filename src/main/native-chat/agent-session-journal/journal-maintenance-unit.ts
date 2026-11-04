import type { JournalOutcomeSource } from './journal-outcome-format'

export type JournalCompactionPosition = { seq: number; field: string; key: string }
export type JournalCompactionSource = JournalOutcomeSource & {
  sessionId: string
  epoch: string
  after: JournalCompactionPosition
}
export type JournalCompactionProgress = {
  more: boolean
  generation: number
  active: JournalCompactionSource | null
  done?: [number, number]
}
export type JournalMaintenanceUnit =
  | { kind: 'compact'; active: JournalCompactionSource }
  | { kind: 'retired'; after: number }
  | { kind: 'vacuum' }
export type JournalMaintenanceResult = {
  more: boolean
  elapsed: number
  progress?: JournalCompactionProgress
  position?: number
}
