import type { HistoryRecoveryFreeze } from './terminal-history-recovery-quarantine'

export type OpenSessionOptions = {
  cwd: string
  cols: number
  rows: number
  recoveryFreeze?: HistoryRecoveryFreeze
  quarantineUnreadableRecovery?: boolean
}

export type HistoryManagerOptions = {
  onWriteError?: (sessionId: string, error: Error) => void
  checkpointMaxBytes?: number
  /** The hosting daemon's resize model (client hello): null is xterm's, undefined unknown. */
  resizeModel?: () => string | null | undefined
}

export type HistoryCheckpointResult = 'committed' | 'retryable' | 'unavailable'
