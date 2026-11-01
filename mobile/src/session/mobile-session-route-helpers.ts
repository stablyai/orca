import type { TerminalModes } from '../terminal/terminal-webview-contract'
import type { ConnectionState } from '../transport/types'
import { translate } from '../i18n/mobile-i18n'

export const MOBILE_SESSION_STATUS_LABELS: Record<ConnectionState, string> = {
  get connecting() {
    return translate('session.routeHelpers.connecting', 'Connecting')
  },
  get handshaking() {
    return translate('session.routeHelpers.securing', 'Securing')
  },
  get connected() {
    return translate('session.routeHelpers.connected', 'Connected')
  },
  get disconnected() {
    return translate('session.routeHelpers.disconnected', 'Disconnected')
  },
  get reconnecting() {
    return translate('session.routeHelpers.reconnecting', 'Reconnecting')
  },
  get 'auth-failed'() {
    return translate('session.routeHelpers.pairingInvalid', 'Pairing invalid')
  }
}

export const TERMINAL_GESTURE_INPUT_BUCKET_CAPACITY = 64
export const TERMINAL_GESTURE_INPUT_REFILL_PER_SECOND = 120
export const TERMINAL_GESTURE_INPUT_MAX_PENDING_SEQUENCES = 32
export const TERMINAL_GESTURE_INPUT_MAX_QUEUE_AGE_MS = 250

export function isFileExistsErrorMessage(message: string): boolean {
  const normalized = message.toLowerCase()
  return normalized.includes('eexist') || normalized.includes('already exists')
}

export function isGestureMouseTrackingMode(
  mode: TerminalModes['mouseTrackingMode'] | undefined
): boolean {
  return mode === 'x10' || mode === 'vt200' || mode === 'drag' || mode === 'any'
}

export function isTerminalPhoneDisplayMode(
  handle: string | null,
  terminalModes: ReadonlyMap<string, 'auto' | 'phone' | 'desktop'>
): boolean {
  if (!handle) {
    return false
  }
  const mode = terminalModes.get(handle)
  return mode === undefined || mode === 'auto' || mode === 'phone'
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
