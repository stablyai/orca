import type { StartupCommandDelivery } from '../../shared/codex-startup-delivery'
import type { SubprocessHandle } from './session'
import type { ShellReadyState, TakePendingOutputResult, TerminalSnapshot } from './types'

export type CreateOrAttachOptions = {
  sessionId: string
  cols: number
  rows: number
  cwd?: string
  env?: Record<string, string>
  envToDelete?: string[]
  command?: string
  startupCommandDelivery?: StartupCommandDelivery
  /** Explicit shell the renderer asked for (e.g. 'wsl.exe' for "New WSL
   *  terminal" from the "+" menu). Forwarded to the subprocess spawner so the
   *  daemon path honors per-tab shell selection the same way LocalPtyProvider
   *  does. */
  shellOverride?: string
  terminalWindowsWslDistro?: string | null
  terminalWindowsPowerShellImplementation?: 'auto' | 'powershell.exe' | 'pwsh.exe'
  shellReadySupported?: boolean
  shellReadyTimeoutMs?: number
  historySeed?: string
  streamClient: { onData: (data: string) => void; onExit: (code: number) => void }
}

export type CreateOrAttachResult = {
  isNew: boolean
  snapshot: TerminalSnapshot | null
  pid: number | null
  shellState: ShellReadyState
  historySeeded?: boolean
  attachToken: symbol
}

export type TerminalHostOptions = {
  spawnSubprocess: (opts: {
    sessionId: string
    cols: number
    rows: number
    cwd?: string
    env?: Record<string, string>
    envToDelete?: string[]
    command?: string
    startupCommandDelivery?: StartupCommandDelivery
    shellOverride?: string
    terminalWindowsWslDistro?: string | null
    terminalWindowsPowerShellImplementation?: 'auto' | 'powershell.exe' | 'pwsh.exe'
  }) => SubprocessHandle
  // Why: on graceful shutdown, the host writes final checkpoints for all live
  // sessions before killing them. This bypasses the RPC round-trip — the daemon
  // writes checkpoints in-process, guaranteeing completion before teardown.
  onFinalCheckpoint?: (
    sessionId: string,
    snapshot: TerminalSnapshot,
    records: TakePendingOutputResult['records']
  ) => void
  // Why: production keeps a large cap, but tests need a small deterministic cap
  // without spawning thousands of full terminal sessions.
  maxTombstones?: number
  // Why: lets the daemon server re-evaluate idle-exit eligibility on every
  // session-map transition instead of polling the host.
  onSessionCountChange?: () => void
}
