import type { TerminalModes } from '../../webview/terminal-webview-contract'
import '../../../i18n/mobile-i18n'

export const TERMINAL_GESTURE_INPUT_BUCKET_CAPACITY = 64

export const TERMINAL_GESTURE_INPUT_REFILL_PER_SECOND = 120

export const TERMINAL_GESTURE_INPUT_MAX_PENDING_SEQUENCES = 32

export const TERMINAL_GESTURE_INPUT_MAX_QUEUE_AGE_MS = 250

export function isGestureMouseTrackingMode(
  mode: TerminalModes['mouseTrackingMode'] | undefined
): boolean {
  return mode === 'x10' || mode === 'vt200' || mode === 'drag' || mode === 'any'
}
