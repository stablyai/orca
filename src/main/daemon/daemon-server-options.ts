import type { DaemonFileLog } from './daemon-file-log'
import type { TerminalHostOptions } from './terminal-host-options'

export type DaemonServerOptions = {
  socketPath: string
  tokenPath: string
  pidPath?: string
  launchNonce?: string
  startedAtMs?: number
  linuxStartTicks?: string
  bootId?: string
  publishEndpointOwnership?: () => void
  entryPath?: string
  appVersion?: string
  spawnerExecPath?: string
  protocolVersion?: number
  onIdleShutdown?: () => void
  onRpcShutdown?: () => void
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
  spawnSubprocess: TerminalHostOptions['spawnSubprocess']
}
