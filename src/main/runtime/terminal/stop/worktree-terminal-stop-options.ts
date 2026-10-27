export type WorktreeTerminalStopOptions = {
  deadline?: number
  /** Past the deadline, still send each remaining PTY a stop without waiting on it. Only for a
   *  caller giving the PTYs up for good: the stop is recorded and may land after it returns. */
  requestStopsPastDeadline?: boolean
  stopPty?: (
    ptyId: string,
    stop: () => Promise<boolean>
  ) => Promise<{ stopped: boolean; owner: boolean }>
  /** Authoritative id for an orphan whose selector no longer resolves. */
  resolvedWorktreeId?: string
  resolvedConnectionId?: string | null
  resolvedRuntimeEnvironmentId?: string
}
