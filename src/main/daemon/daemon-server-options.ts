import type { DaemonFileLog } from './daemon-file-log'
import type { SubprocessHandle } from './session-subprocess-handle'
import type { TerminalSpawnAdmissionMode } from './terminal-spawn-gate'
import type { HostTerminalPolicy } from './host-terminal-policy'

export type DaemonServerOptions = {
  socketPath: string
  tokenPath: string
  pidPath?: string
  launchNonce?: string
  startedAtMs?: number
  publishEndpointOwnership?: () => void
  entryPath?: string
  appVersion?: string
  spawnerExecPath?: string
  protocolVersion?: number
  onIdleShutdown?: () => void
  onRpcShutdown?: () => void
  onShutdownRequested?: () => void
  initialAdoptionTestConfig?: {
    timeoutMs: number
    clock: {
      setTimeout(callback: () => void, delayMs: number): unknown
      clearTimeout(handle: unknown): void
      now(): number
    }
  }
  ptySpawnHealthCheck?: () => Promise<void>
  preparePtySpawn?: () => Promise<void>
  onPtySessionExit?: (sessionId: string) => void
  onAuthenticatedClientPair?: () => void
  log?: DaemonFileLog
  /** Headless hosts enforce; desktop only observes until the client handles deferral. */
  spawnAdmission?: TerminalSpawnAdmissionMode
  /** Crash-recovery state for automatic restores. */
  automaticWorkMarkerPath?: string
  /** Shared terminal counts for the host-wide cap. */
  hostTerminalLedgerDir?: string
  terminalLimitPolicy?: HostTerminalPolicy
  spawnSubprocess: (opts: {
    sessionId: string
    cols: number
    rows: number
    cwd?: string
    env?: Record<string, string>
    command?: string
    shellOverride?: string
    isCanceled?: () => boolean
  }) => SubprocessHandle | Promise<SubprocessHandle>
}
