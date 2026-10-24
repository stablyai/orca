import type { ChildProcess } from 'node:child_process'
import type { CdpWsProxy } from './cdp-ws-proxy'
import type { BrowserError } from './cdp-bridge'

// Exceed agent-browser's internal navigation (30s) and wait (60s) timeouts.
export const EXEC_TIMEOUT_MS = 90_000
export const CONSECUTIVE_TIMEOUT_LIMIT = 3
export const WAIT_PROCESS_TIMEOUT_GRACE_MS = 1_000
export const STALE_SESSION_CLOSE_TIMEOUT_MS = 3_000
export const AGENT_BROWSER_EXIT_DRAIN_MS = 500
// Cleanup must finish within the 20s quit barrier.
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
  // Restore these routes after a session restart.
  activeInterceptPatterns: string[]
  activeCapture: boolean
  // Detect idle daemon retirement from the gap between commands.
  lastCommandAt: number
  // Revalidate after queue delay, when the tab may have disappeared.
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
  /** Preserve queued commands for the replacement session. */
  keepQueuedCommands?: boolean
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
  // Text mutations must not fall back to a global tab from another worktree.
  requireScopedTarget?: boolean
}

export type AgentBrowserBridgeOptions = {
  onTabsChanged?: (worktreeId?: string) => void
}
