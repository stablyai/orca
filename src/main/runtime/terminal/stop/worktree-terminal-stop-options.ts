export type WorktreeTerminalStopOptions = {
  deadline?: number
  stopPty?: (
    ptyId: string,
    stop: () => Promise<boolean>
  ) => Promise<{ stopped: boolean; owner: boolean }>
  /** Authoritative id for an orphan whose selector no longer resolves. */
  resolvedWorktreeId?: string
  resolvedConnectionId?: string | null
  resolvedRuntimeEnvironmentId?: string
}
