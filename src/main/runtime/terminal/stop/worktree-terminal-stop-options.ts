import type { RuntimePtyWorktreeRecord } from '../records/runtime-terminal-state-records'
import type { ObservedPtyShutdownOptions } from '../../../ipc/pty/provider/shutdown-detect'

export type WorktreePtyStopContext = Pick<
  ObservedPtyShutdownOptions,
  'expectedIncarnationId' | 'establishedOwnerOnly' | 'onExitEvidence'
>

export type WorktreeTerminalStopSnapshot = {
  leaseHeld?: boolean
  ptyIds: Set<string>
  records: Map<string, RuntimePtyWorktreeRecord | undefined>
  assertCurrent(ptyId?: string): void
}

export type WorktreeTerminalStopOptions = {
  snapshot?: WorktreeTerminalStopSnapshot
  deadline?: number
  /** Past the deadline, still send each remaining PTY a stop without waiting on it. Only for a
   *  caller giving the PTYs up for good: the stop is recorded and may land after it returns. */
  requestStopsPastDeadline?: boolean
  stopPty?: (
    ptyId: string,
    stop: (context?: WorktreePtyStopContext) => Promise<boolean>
  ) => Promise<{ stopped: boolean; owner: boolean }>
  /** Authoritative id for an orphan whose selector no longer resolves. */
  resolvedWorktreeId?: string
  resolvedConnectionId?: string | null
  resolvedRuntimeEnvironmentId?: string
}
