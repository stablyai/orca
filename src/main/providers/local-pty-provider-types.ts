import type { TerminalExitCause } from '../../shared/terminal-exit-cause'
import type { PtySpawnOptions } from './pty-provider-contract'

export type LocalPtyProviderOptions = {
  /** Agent command selects overlay directories; disk-presence fallback can shadow another agent. */
  buildSpawnEnv?: (
    id: string,
    baseEnv: Record<string, string>,
    ctx?: {
      explicitEnv?: PtySpawnOptions['env']
      command?: string
      launchAgent?: PtySpawnOptions['launchAgent']
      codexHomePathOverride?: PtySpawnOptions['codexHomePathOverride']
      cwd?: string
      shellPath?: string
      isWsl?: boolean
      wslDistro?: string | null
      /** A restore no user act asked for (#35813): its prep must not start a stopped distro. */
      wslPassiveRestore?: boolean
    }
    // Async Codex hook/trust preparation must keep Electron main responsive (#16441).
  ) => Record<string, string> | Promise<Record<string, string>>
  /** Defaults to history isolation when a workspace id is present. */
  isHistoryEnabled?: () => boolean
  /** Persisted preference; COMSPEC identifies cmd.exe regardless of the chosen shell. */
  getWindowsShell?: () => string | undefined
  getDefaultShell?: () => string | undefined
  getWindowsPowerShellImplementation?: () => 'auto' | 'powershell.exe' | 'pwsh.exe' | undefined
  pwshAvailable?: () => boolean | Promise<boolean>
  onSpawned?: (id: string, incarnationId: string) => void
  onExit?: (id: string, code: number, incarnationId: string, cause?: TerminalExitCause) => void
  onData?: (
    id: string,
    data: string,
    timestamp: number,
    sequenceChars?: number,
    transformed?: boolean
  ) => void
}
