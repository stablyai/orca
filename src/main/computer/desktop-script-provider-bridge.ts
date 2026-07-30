import { executeSupervisedDesktopProvider } from './computer-provider-supervisor-client'
import { RuntimeClientError } from './runtime-client-error'
import type { BridgeRequest } from './desktop-script-provider-types'

export async function execBridge(
  request: BridgeRequest
): Promise<{ stdout: string; stderr: string }> {
  const result = await executeSupervisedDesktopProvider(withoutUndefinedValues(request))
  if (result.error) {
    throw mapBridgeError(result.error.message)
  }
  return { stdout: result.stdout, stderr: result.stderr }
}

function withoutUndefinedValues(request: BridgeRequest): BridgeRequest {
  return Object.fromEntries(
    Object.entries(request).filter(([, value]) => value !== undefined)
  ) as BridgeRequest
}

export function mapBridgeError(message: string): RuntimeClientError {
  const text = message.trim() || 'desktop provider failed'
  if (/appNotFound|app not found/i.test(text)) {
    return new RuntimeClientError('app_not_found', text)
  }
  if (/appBlocked|app blocked/i.test(text)) {
    return new RuntimeClientError('app_blocked', text)
  }
  if (
    /unsupported capability|hotkey.*require|paste_text requires|modified clicks require xdotool|GDK is required for non-character key synthesis/i.test(
      text
    )
  ) {
    return new RuntimeClientError('unsupported_capability', text)
  }
  if (
    /unsupported mouse button|unsupported scroll direction|unsupported (?:key|modifier)|windowId is not supported|must be a positive|must be a finite number|\b(?:x|y|from_x|from_y|to_x|to_y|pages|click_count|text|key|direction) is required\b/i.test(
      text
    )
  ) {
    return new RuntimeClientError('invalid_argument', text)
  }
  if (/ModuleNotFoundError: No module named 'gi'|PyGObject|python3-gi/i.test(text)) {
    return new RuntimeClientError(
      'unsupported_capability',
      'Linux Computer Use requires python3-gi and AT-SPI packages. Install python3-gi gir1.2-atspi-2.0 at-spi2-core, then retry.'
    )
  }
  if (/not a valid secondary action|action.*not supported/i.test(text)) {
    return new RuntimeClientError('action_not_supported', text)
  }
  if (/value is not settable|not settable/i.test(text)) {
    return new RuntimeClientError('value_not_settable', text)
  }
  if (/stale element|fresh element index/i.test(text)) {
    return new RuntimeClientError('element_not_found', text)
  }
  if (/windowStale|window stale/i.test(text)) {
    return new RuntimeClientError('window_stale', text)
  }
  if (
    /window_not_focused|keyboard input requires.*window.*focused|target window.*focused/i.test(text)
  ) {
    return new RuntimeClientError('window_not_focused', text)
  }
  if (/screenshot_failed|screenshot.*failed|screen recording|payload cap/i.test(text)) {
    return new RuntimeClientError('screenshot_failed', text)
  }
  if (
    /window_not_found|No top-level(?: AT-SPI| UI Automation)? window|has no (?:on-screen |accessibility )?window|could not match accessibility window|unknown window(?:_index| id)?/i.test(
      text
    )
  ) {
    return new RuntimeClientError('window_not_found', text)
  }
  if (/permission|desktop session|DBUS|XDG_RUNTIME_DIR|AT-SPI/i.test(text)) {
    return new RuntimeClientError('permission_denied', text)
  }
  if (
    /element_not_found|stale element|fresh element index|unknown element_index|element \d+ is stale|element indexes require|element \d+ changed since|element \d+ is not in the current cached snapshot/i.test(
      text
    )
  ) {
    return new RuntimeClientError('element_not_found', text)
  }
  return new RuntimeClientError('accessibility_error', text)
}
