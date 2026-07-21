import type { StartupCommandDelivery } from '../../shared/codex-startup-delivery'
import type { TuiAgent } from '../../shared/types'
import type { ShellReadyState, TerminalSnapshot } from './types'
import type { PtyStartupIngressIntent } from '../../shared/pty-startup-ingress'

export type CreateOrAttachOptions = {
  sessionId: string
  cols: number
  rows: number
  cwd?: string
  env?: Record<string, string>
  envToDelete?: string[]
  command?: string
  startupCommandDelivery?: StartupCommandDelivery
  launchAgent?: TuiAgent
  /** Explicit shell the renderer asked for, forwarded to the subprocess. */
  shellOverride?: string
  terminalWindowsWslDistro?: string | null
  terminalWindowsPowerShellImplementation?: 'auto' | 'powershell.exe' | 'pwsh.exe'
  shellReadySupported?: boolean
  shellReadyTimeoutMs?: number
  historySeed?: string
  startupIngress?: PtyStartupIngressIntent
  streamClient: {
    onData: (data: string, rawLength?: number, transformed?: boolean, seq?: number) => void
    onExit: (code: number) => void
  }
}

export type CreateOrAttachResult = {
  isNew: boolean
  snapshot: TerminalSnapshot | null
  pid: number | null
  shellState: ShellReadyState
  historySeeded?: boolean
  launchAgent?: TuiAgent
  wslDistro: string | null
  attachToken: symbol
}
