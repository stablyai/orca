import type { TerminalExitCause } from '../../shared/terminal-exit-cause'
import type { PtySpawnOptions } from './types'

export type LocalPtyProviderOptions = {
  /** Why: `ctx.command` (pi/omp/claude) must drive overlay source-dir selection — a disk-presence fallback shadows the other agent's extensions. */
  buildSpawnEnv?: (
    id: string,
    baseEnv: Record<string, string>,
    ctx?: {
      command?: string
      launchAgent?: PtySpawnOptions['launchAgent']
      codexHomePathOverride?: PtySpawnOptions['codexHomePathOverride']
      cwd?: string
      shellPath?: string
      isWsl?: boolean
      wslDistro?: string | null
    }
    // Why (#16441): Codex launch prep grants hook trust through a codex
    // app-server session. `spawn` already awaits, so returning a promise keeps
    // the Electron main thread responsive instead of blocking on spawnSync.
  ) => Record<string, string> | Promise<Record<string, string>>
  /** Whether worktree-scoped shell history is enabled; when true (or absent) with a worktreeId, HISTFILE is scoped per-worktree. */
  isHistoryEnabled?: () => boolean
  /** Why: COMSPEC is always cmd.exe, so this callback injects the user's persisted shell preference. Undefined when none set. */
  getWindowsShell?: () => string | undefined
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
