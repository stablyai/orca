import type { HistoryRecoveryFreeze } from './terminal-history-recovery-quarantine'

export type OpenSessionOptions = {
  cwd: string
  cols: number
  rows: number
  recoveryFreeze?: HistoryRecoveryFreeze
  quarantineUnreadableRecovery?: boolean
  /** Incognito ("no-session"): mark the session so this open — and every later writer registration —
   *  is a no-op, leaving no history dir/output.log/checkpoint on disk. */
  incognito?: boolean
}

export type HistoryManagerOptions = {
  onWriteError?: (sessionId: string, error: Error) => void
  checkpointMaxBytes?: number
}

export type HistoryCheckpointResult = 'committed' | 'retryable' | 'unavailable'
