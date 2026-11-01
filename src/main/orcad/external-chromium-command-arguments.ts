import { BrowserError } from '../browser/browser-error'
import { agentBrowserSetMediaArguments } from '../browser/agent-browser-set-media-arguments'
import { agentBrowserWaitArguments } from '../browser/agent-browser-wait-arguments'
const TARGET_OVERRIDE_FLAGS: Record<string, true> = {
  '--args': true,
  '--cdp': true,
  '--executable-path': true,
  '--profile': true,
  '--session': true
}
const TARGET_OVERRIDE_FLAG_PREFIXES = Object.keys(TARGET_OVERRIDE_FLAGS).map((flag) => `${flag}=`)

function parseExecArguments(input: string): string[] {
  const args: string[] = []
  let value = ''
  let quote: '"' | "'" | null = null
  let escaped = false
  for (const char of input.trim()) {
    if (escaped) {
      value += char
      escaped = false
    } else if (char === '\\' && quote !== "'") {
      escaped = true
    } else if (quote) {
      if (char === quote) {
        quote = null
      } else {
        value += char
      }
    } else if (char === '"' || char === "'") {
      quote = char
    } else if (/\s/.test(char)) {
      if (value) {
        args.push(value)
        value = ''
      }
    } else {
      value += char
    }
  }
  if (escaped) {
    value += '\\'
  }
  if (quote) {
    throw new BrowserError('invalid_argument', 'Browser command has an unclosed quote.')
  }
  if (value) {
    args.push(value)
  }
  return args
}
function stripTargetOverrideArguments(args: string[]): string[] {
  const stripped: string[] = []
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (TARGET_OVERRIDE_FLAGS[arg]) {
      index++
      continue
    }
    if (TARGET_OVERRIDE_FLAG_PREFIXES.some((prefix) => arg.startsWith(prefix))) {
      continue
    }
    stripped.push(arg)
  }
  return stripped
}

export function externalChromiumWaitCommand(
  params: Record<string, unknown>
): ReturnType<typeof agentBrowserWaitArguments> {
  const optional = (key: string): string | undefined =>
    params[key] ? String(params[key]) : undefined
  return agentBrowserWaitArguments({
    selector: optional('selector'),
    timeout: typeof params.timeout === 'number' ? params.timeout : undefined,
    text: optional('text'),
    url: optional('url'),
    load: optional('load'),
    fn: optional('fn'),
    state: optional('state')
  })
}

function cookieSetArguments(params: Record<string, unknown>): string[] {
  const args = ['cookies', 'set', String(params.name ?? ''), String(params.value ?? '')]
  for (const [key, flag] of [
    ['domain', '--domain'],
    ['path', '--path'],
    ['sameSite', '--sameSite'],
    ['expires', '--expires']
  ] as const) {
    if (params[key] != null) {
      args.push(flag, String(params[key]))
    }
  }
  if (params.secure) {
    args.push('--secure')
  }
  if (params.httpOnly) {
    args.push('--httpOnly')
  }
  return args
}
function cookieDeleteArguments(params: Record<string, unknown>): string[] {
  const args = ['cookies', 'clear']
  if (params.name) {
    args.push('--name', String(params.name))
  }
  if (params.domain) {
    args.push('--domain', String(params.domain))
  }
  return args
}

export function externalChromiumCommandArguments(
  method: string,
  params: Record<string, unknown>
): string[] | null {
  const text = (key: string): string => String(params[key] ?? '')
  const optional = (key: string): string[] => (params[key] == null ? [] : [String(params[key])])
  switch (method) {
    case 'browserClick':
      return ['click', text('element')]
    case 'browserDblclick':
      return ['dblclick', text('element')]
    case 'browserFill':
      return ['fill', text('element'), text('value')]
    case 'browserType':
      return ['keyboard', 'type', text('input')]
    case 'browserSelect':
      return ['select', text('element'), text('value')]
    case 'browserScroll':
      return ['scroll', text('direction'), ...optional('amount')]
    case 'browserHover':
      return ['hover', text('element')]
    case 'browserDrag':
      return ['drag', text('from'), text('to')]
    case 'browserUpload':
      return ['upload', text('element'), ...((params.files as string[] | undefined) ?? [])]
    case 'browserCheck':
      return [params.checked === false ? 'uncheck' : 'check', text('element')]
    case 'browserFocus':
      return ['focus', text('element')]
    case 'browserClear':
      return ['fill', text('element'), '']
    case 'browserKeypress':
      return ['press', text('key')]
    case 'browserScrollIntoView':
      return ['scrollintoview', text('element')]
    case 'browserGet':
      return ['get', text('what'), ...optional('selector')]
    case 'browserIs':
      return ['is', text('what'), text('selector')]
    case 'browserKeyboardInsertText':
      return ['keyboard', 'inserttext', text('text')]
    case 'browserMouseMove':
      return ['mouse', 'move', text('x'), text('y')]
    case 'browserMouseDown':
      return ['mouse', 'down', ...optional('button')]
    case 'browserMouseClick':
      if (
        params.radius != null ||
        (Array.isArray(params.modifiers) && params.modifiers.length > 0)
      ) {
        return null
      }
      return ['mouse', 'click', text('x'), text('y'), ...optional('button')]
    case 'browserMouseUp':
      return ['mouse', 'up', ...optional('button')]
    case 'browserMouseWheel':
      return ['mouse', 'wheel', text('dy'), ...optional('dx')]
    case 'browserFind':
      return ['find', text('locator'), text('value'), text('action'), ...optional('text')]
    case 'browserSetDevice':
      return ['set', 'device', text('name')]
    case 'browserSetOffline':
      return ['set', 'offline', ...optional('state')]
    case 'browserSetHeaders':
      return ['set', 'headers', text('headers')]
    case 'browserSetCredentials':
      return ['set', 'credentials', text('user'), text('pass')]
    case 'browserSetMedia':
      return agentBrowserSetMediaArguments(params.colorScheme, params.reducedMotion)
    case 'browserClipboardRead':
      return ['clipboard', 'read']
    case 'browserClipboardWrite':
      return ['clipboard', 'write', text('text')]
    case 'browserDialogAccept':
      return ['dialog', 'accept', ...optional('text')]
    case 'browserDialogDismiss':
      return ['dialog', 'dismiss']
    case 'browserStorageLocalGet':
      return ['storage', 'local', 'get', text('key')]
    case 'browserStorageLocalSet':
      return ['storage', 'local', 'set', text('key'), text('value')]
    case 'browserStorageLocalClear':
      return ['storage', 'local', 'clear']
    case 'browserStorageSessionGet':
      return ['storage', 'session', 'get', text('key')]
    case 'browserStorageSessionSet':
      return ['storage', 'session', 'set', text('key'), text('value')]
    case 'browserStorageSessionClear':
      return ['storage', 'session', 'clear']
    case 'browserDownload':
      return ['download', text('selector'), text('path')]
    case 'browserHighlight':
      return ['highlight', text('selector')]
    case 'browserCookieGet':
      return ['cookies', 'get']
    case 'browserCookieDelete':
      return cookieDeleteArguments(params)
    case 'browserSetGeolocation':
      return ['set', 'geo', text('latitude'), text('longitude')]
    case 'browserInterceptDisable':
      return ['network', 'unroute']
    case 'browserInterceptList':
    case 'browserNetworkLog':
      return ['network', 'requests']
    case 'browserConsoleLog':
      return ['console']
    case 'browserCaptureStart':
      return ['network', 'har', 'start']
    case 'browserCaptureStop':
      return ['network', 'har', 'stop']
    case 'browserExec':
      return stripTargetOverrideArguments(parseExecArguments(text('command')))
    case 'browserSetViewport':
      if (
        params.mobile === true ||
        (params.deviceScaleFactor != null && params.deviceScaleFactor !== 1)
      ) {
        return null
      }
      return ['set', 'viewport', text('width'), text('height')]
    case 'browserCookieSet':
      return cookieSetArguments(params)
    case 'browserInterceptEnable':
      return ['network', 'route', (params.patterns as string[] | undefined)?.[0] ?? '**/*']
    default:
      return null
  }
}

export function normalizeExternalChromiumCommandResult(
  method: string,
  params: Record<string, unknown>,
  result: unknown
): unknown {
  switch (method) {
    case 'browserClick':
      return { clicked: String(params.element) }
    case 'browserFill':
      return { filled: String(params.element) }
    case 'browserType':
      return { typed: true }
    case 'browserSelect':
      return { selected: String(params.value) }
    case 'browserScroll':
      return { scrolled: params.direction }
    case 'browserHover':
      return { hovered: String(params.element) }
    case 'browserDrag':
      return { dragged: { from: params.from, to: params.to } }
    case 'browserUpload':
      return { uploaded: Array.isArray(params.files) ? params.files.length : 0 }
    case 'browserCheck':
      return { checked: params.checked !== false }
    case 'browserFocus':
      return { focused: String(params.element) }
    case 'browserClear':
      return { cleared: String(params.element) }
    case 'browserSelectAll':
      return { selected: String(params.element) }
    case 'browserKeypress':
      return { pressed: String(params.key) }
    case 'browserSetViewport':
      return {
        width: params.width,
        height: params.height,
        deviceScaleFactor: 1,
        mobile: false
      }
    default:
      return result
  }
}
