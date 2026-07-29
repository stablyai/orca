import type { TerminalModes } from '../terminal/terminal-webview-contract'
import type { ConnectionState } from '../transport/types'

export const MOBILE_SESSION_STATUS_LABELS: Record<ConnectionState, string> = {
  connecting: 'Connecting',
  handshaking: 'Securing',
  connected: 'Connected',
  disconnected: 'Disconnected',
  reconnecting: 'Reconnecting',
  'auth-failed': 'Pairing invalid'
}

export const TERMINAL_GESTURE_INPUT_BUCKET_CAPACITY = 64
export const TERMINAL_GESTURE_INPUT_REFILL_PER_SECOND = 120
export const TERMINAL_GESTURE_INPUT_FLUSH_DELAY_MS = 16
export const TERMINAL_GESTURE_INPUT_MAX_PENDING_SEQUENCES = 32
export const TERMINAL_GESTURE_INPUT_MAX_QUEUE_AGE_MS = 250

export function isFileExistsErrorMessage(message: string): boolean {
  const normalized = message.toLowerCase()
  return normalized.includes('eexist') || normalized.includes('already exists')
}

export function getRepoIdFromMobileWorktreeId(id: string): string {
  // Why: mobile cannot import desktop shared modules in its standalone tsc run,
  // but the runtime worktree id wire format is still `${repoId}::${path}`.
  const separatorIdx = id.indexOf('::')
  return separatorIdx === -1 ? id : id.slice(0, separatorIdx)
}

export function isGestureMouseTrackingMode(
  mode: TerminalModes['mouseTrackingMode'] | undefined
): boolean {
  return mode === 'x10' || mode === 'vt200' || mode === 'drag' || mode === 'any'
}

export function getActiveTabIdForHandle(
  tabs: ReadonlyArray<{ id: string; type: string; terminal?: string | null }>,
  terminalHandle: string | null
): string | null {
  if (!terminalHandle) {
    return null
  }
  return (
    tabs.find((tab) => tab.type === 'terminal' && tab.terminal === terminalHandle)?.id ??
    terminalHandle
  )
}

export function updateTerminalCwdFromStreamEvent(
  handle: string,
  data: Readonly<Record<string, unknown>>,
  terminalCwd: Map<string, string>
): void {
  if (!('cwd' in data)) {
    return
  }
  if (typeof data.cwd === 'string' && data.cwd.trim().length > 0) {
    terminalCwd.set(handle, data.cwd)
    return
  }
  terminalCwd.delete(handle)
}
