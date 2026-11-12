import type { HistoryRecoveryFreeze } from './terminal-history-recovery-quarantine'
import type { HistoryWriterAdmission } from './terminal-history-writer-handoff'

export type OpenSessionOptions = {
  cwd: string
  cols: number
  rows: number
  recoveryFreeze?: HistoryRecoveryFreeze
  quarantineUnreadableRecovery?: boolean
  /** Captured by the producer before its awaits; a closed one leaves the directory untouched. */
  admission?: HistoryWriterAdmission
}

export type HistoryManagerOptions = {
  onWriteError?: (sessionId: string, error: Error) => void
  checkpointMaxBytes?: number
  /** The hosting daemon's resize model (client hello): null is xterm's, undefined unknown. */
  resizeModel?: () => string | null | undefined
}

export type HistoryCheckpointResult = 'committed' | 'retryable' | 'unavailable'
