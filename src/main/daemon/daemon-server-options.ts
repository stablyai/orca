import type { DaemonFileLog } from './daemon-file-log'
import type { SubprocessHandle } from './session-subprocess-handle'
import type { TerminalSpawnAdmissionMode } from './terminal-spawn-gate'

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
  /** Where the daemon remembers whether automatic restores were running when it died. */
  automaticWorkMarkerPath?: string
  /** Where every daemon on this host shares its terminal count for the host cap. */
  hostTerminalLedgerDir?: string
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
