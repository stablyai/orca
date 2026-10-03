import type { RecognizedAgentProcess } from '../../../shared/agent-process-recognition'
import type {
  AgentPresenceCaptureOptions,
  AgentProcessPresence
} from '../../../shared/agent-process-presence'
import type { IPty } from 'node-pty'
import {
  captureAgentForegroundIdentity,
  type AgentForegroundObservation
} from '../../../shared/agent-foreground-identity'
import { captureWindowsAgentPresence } from '../../providers/windows-agent-presence'

export async function capturePtyAgentPresence(
  proc: IPty,
  isDead: () => boolean,
  observed: CachedAgentForeground | null,
  readForeground: () => Promise<AgentForegroundObservation>
) {
  if (isDead()) {
    return undefined
  }
  const presence =
    process.platform === 'win32'
      ? observed?.pid && Date.now() - observed.refreshedAt <= 1_000
        ? await captureWindowsAgentPresence(proc, {
            available: true,
            processName: observed.processName,
            processId: observed.pid,
            processStartTime: observed.processStartTime
          })
        : undefined
      : await captureAgentForegroundIdentity(readForeground)
  return isDead() ? undefined : presence
}

export type PtyForegroundProcessTracker = {
  captureAgentPresence(
    options?: AgentPresenceCaptureOptions
  ): Promise<AgentProcessPresence | undefined>
  recordOutput(data: string): void
  markDead(): void
  /** `rawFallback`: node-pty's own name only, with no identity cache and no background
   *  process-table refresh -- the cheap-tier tick must not fork a full `ps` as a side effect. */
  getForegroundProcess(options?: { rawFallback?: boolean }): string | null
  confirmForegroundProcess(): Promise<string | null>
  confirmShellForeground(): Promise<boolean>
}

export type CachedAgentForeground = {
  processName: string
  pid: number | null
  processStartTime?: string
  refreshedAt: number
}

export type PtyForegroundTrackerOptions = {
  process: IPty
  shellPath: string
  cwd?: string
  sessionId: string
  startupAgentRecognition: RecognizedAgentProcess | null
  isDead: () => boolean
}
