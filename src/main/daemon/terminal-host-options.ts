import type { PtyCreationDisposition } from '../../shared/claimed-agent-pty-owner'
import type { StartupCommandDelivery } from '../../shared/codex-startup-delivery'
import type { TuiAgent } from '../../shared/tui-agent'
import type { SubprocessHandle } from './session-subprocess-handle'
import type { TakePendingOutputResult, TerminalSnapshot } from './types'
import type { TerminalSpawnGate } from './terminal-spawn-gate'

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
    launchAgent?: TuiAgent
    shellOverride?: string
    terminalShellArgs?: string[]
    terminalWindowsWslDistro?: string | null
    terminalWindowsPowerShellImplementation?: 'auto' | 'powershell.exe' | 'pwsh.exe'
    onCreationDisposition?: (disposition: PtyCreationDisposition) => void
    assertCreateAllowed?: () => void
    isCanceled?: () => boolean
    cancelSignal?: AbortSignal
  }) => SubprocessHandle | Promise<SubprocessHandle>
  // Login-session death detection needs exits even when no viewer is attached.
  onSessionReaped?: (sessionId: string) => void
  /** Use an injected file-log sink because detached daemon stdio is ignored. */
  reportReadinessEvent?: (event: string, details: Record<string, unknown>) => void
  // Finish shutdown checkpoints in-process before native teardown.
  onFinalCheckpoint?: (
    sessionId: string,
    snapshot: TerminalSnapshot,
    records: TakePendingOutputResult['records']
  ) => void
  /** Charged only on the branch that forks; attach and adoption never reach it. */
  spawnGate?: TerminalSpawnGate
  // Allow deterministic eviction tests without creating thousands of sessions.
  maxTombstones?: number
}
