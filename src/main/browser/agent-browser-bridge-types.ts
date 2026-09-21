import type { ChildProcess } from 'node:child_process'
import type { CdpWsProxy } from './cdp-ws-proxy'
import type { BrowserError } from './cdp-bridge'

// Why: must exceed agent-browser's internal timeouts (goto 30s, wait 60s) so the bridge never kills a command before its own timeout fires.
export const EXEC_TIMEOUT_MS = 90_000
export const CONSECUTIVE_TIMEOUT_LIMIT = 3
export const WAIT_PROCESS_TIMEOUT_GRACE_MS = 1_000
export const STALE_SESSION_CLOSE_TIMEOUT_MS = 3_000
// Why separate from EXEC_TIMEOUT_MS: a close is a member of the 20s will-quit barrier and must finish well inside it.
export const AGENT_BROWSER_CLEANUP_TIMEOUT_MS = 5_000
export const AGENT_BROWSER_CLEANUP_CONCURRENCY = 4
export const EMBEDDED_NAVIGATION_TIMEOUT_MS = 30_000
export const AGENT_BROWSER_TEXT_ARGUMENT_MAX_BYTES = 8 * 1024
export const AGENT_BROWSER_CLIPBOARD_WRITE_MAX_BYTES = AGENT_BROWSER_TEXT_ARGUMENT_MAX_BYTES

export type SessionState = {
  proxy: CdpWsProxy
  cdpEndpoint: string
  initialized: boolean
  consecutiveTimeouts: number
  // Why: track active interception patterns so they can be re-enabled after session restart
  activeInterceptPatterns: string[]
  activeCapture: boolean
  // Why: the daemon retires itself once idle; the gap since the last command is how the bridge notices.
  lastCommandAt: number
  // Why: verify the tab is alive at execution time, not just enqueue time — queue delay can destroy it in between.
  webContentsId: number
  activeProcess: ChildProcess | null
}

export type QueuedCommand = {
  execute: () => Promise<unknown>
  resolve: (value: unknown) => void
  reject: (reason: unknown) => void
}

export type ResolvedBrowserCommandTarget = {
  browserPageId: string
  webContentsId: number
}

export type AgentBrowserCleanupOptions = {
  closeTimeoutMs?: number
}

export type BrowserMouseModifier = 'cmd' | 'ctrl' | 'alt' | 'shift'

export type AgentBrowserExecOptions = {
  envOverrides?: NodeJS.ProcessEnv
  timeoutMs?: number
  timeoutError?: BrowserError
  stdinText?: string
}

export type EnqueueTargetedCommandOptions = {
  ensureSession?: boolean
  ensureVisible?: boolean
  // Why: text-mutating commands must never fall back to the global tab (may be a worktree the user is viewing).
  requireScopedTarget?: boolean
}

export type AgentBrowserBridgeOptions = {
  onTabsChanged?: (worktreeId?: string) => void
}
