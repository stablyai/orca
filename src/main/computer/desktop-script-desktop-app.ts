import type { NativeDesktopAppMethod } from './macos-native-provider-contract'
import type { BridgeRequest, BridgeResponse } from './desktop-script-provider-types'
import { RuntimeClientError } from './runtime-client-error'
import type { DesktopScriptPlatform } from './desktop-script-provider-paths'

type CallBridge = (request: BridgeRequest) => Promise<BridgeResponse>

// Matches DESKTOP_APP_PIXELS_PER_SCROLL_STEP in native/computer-use-linux/runtime.py.
const LINUX_PIXELS_PER_SCROLL_STEP = 50
// A remainder older than this belongs to a finished gesture, not the next one.
const SCROLL_REMAINDER_TTL_MS = 1000

type ScrollRemainder = { x: number; y: number; at: number }
const linuxScrollRemainders = new Map<string, ScrollRemainder>()

/**
 * Desktop App pane calls on the Windows/Linux script runtimes. Same result shape as the macOS
 * helper: `{ windows }` for the list and `{ path }` for input.
 */
export async function callDesktopScriptDesktopApp(
  callBridge: CallBridge,
  method: NativeDesktopAppMethod,
  params: unknown,
  orcaPid: number = process.ppid,
  platform: DesktopScriptPlatform | null = null
): Promise<unknown> {
  const record = isRecord(params) ? params : {}
  if (method === 'listDesktopWindows') {
    // Why: the sidecar is forked by Orca main, so its parent pid owns Orca's own windows,
    // which must never be offered as a target (the pane would capture itself).
    const response = await callBridge({ tool: 'list_desktop_windows', excludePid: orcaPid })
    return { windows: Array.isArray(response.desktopWindows) ? response.desktopWindows : [] }
  }
  const pid = positiveInteger(record.pid, 'pid')
  const windowId = positiveInteger(record.windowId, 'windowId')
  if (!isRecord(record.input)) {
    throw new RuntimeClientError('invalid_argument', 'input is required')
  }
  let input = record.input
  if (platform === 'linux' && input.kind === 'scroll') {
    const whole = takeWholeLinuxScrollSteps(`${pid}:${windowId}`, input)
    if (!whole) {
      return { path: 'synthetic' }
    }
    input = whole
  }
  const response = await callBridge({ tool: 'desktop_input', pid, windowId, input })
  return { path: response.path === 'accessibility' ? 'accessibility' : 'synthetic' }
}

/**
 * X11 scrolls in whole wheel steps, and the runtime rounds any nonzero delta up to one, so the
 * small per-frame deltas of a trackpad would each become a full step. Sends only whole steps and
 * keeps the rest for the next frame of the same window; null when nothing whole is left to send.
 */
function takeWholeLinuxScrollSteps(
  key: string,
  input: Record<string, unknown>,
  now: number = Date.now()
): Record<string, unknown> | null {
  const deltaX = typeof input.deltaX === 'number' ? input.deltaX : 0
  const deltaY = typeof input.deltaY === 'number' ? input.deltaY : 0
  if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)) {
    // The runtime rejects a non-finite delta with its own message.
    return input
  }
  const previous = linuxScrollRemainders.get(key)
  const fresh = previous && now - previous.at <= SCROLL_REMAINDER_TTL_MS ? previous : null
  const totalX = deltaX + (fresh?.x ?? 0)
  const totalY = deltaY + (fresh?.y ?? 0)
  const wholeX = Math.trunc(totalX / LINUX_PIXELS_PER_SCROLL_STEP) * LINUX_PIXELS_PER_SCROLL_STEP
  const wholeY = Math.trunc(totalY / LINUX_PIXELS_PER_SCROLL_STEP) * LINUX_PIXELS_PER_SCROLL_STEP
  const rest = { x: totalX - wholeX, y: totalY - wholeY, at: now }
  if (rest.x === 0 && rest.y === 0) {
    linuxScrollRemainders.delete(key)
  } else {
    linuxScrollRemainders.set(key, rest)
  }
  return wholeX === 0 && wholeY === 0 ? null : { ...input, deltaX: wholeX, deltaY: wholeY }
}

/** Test seam: forgets every kept scroll remainder. */
export function resetLinuxScrollRemaindersForTest(): void {
  linuxScrollRemainders.clear()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function positiveInteger(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new RuntimeClientError('invalid_argument', `${name} must be a positive integer`)
  }
  return value
}
