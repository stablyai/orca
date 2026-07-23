import type {
  BrowserConsoleEntry,
  BrowserInterceptedRequest,
  BrowserNetworkEntry
} from '../../shared/runtime-types'

export const CDP_CAPTURE_LOG_LIMIT = 1000
export const CDP_MAX_PAUSED_REQUESTS = 256
export const CDP_MAX_IFRAME_SESSIONS = 1024
export const CDP_MAX_CONSOLE_ARGUMENTS = 1024
export const CDP_MAX_CONSOLE_TEXT_CODE_UNITS = 16 * 1024
export const CDP_MAX_CAPTURE_URL_CODE_UNITS = 16 * 1024
export const CDP_MAX_INTERCEPTED_HEADERS = 256
export const CDP_MAX_INTERCEPTED_METADATA_CODE_UNITS = 64 * 1024
const CDP_MAX_LEVEL_CODE_UNITS = 32
const CDP_MAX_MIME_TYPE_CODE_UNITS = 1024
const CDP_MAX_SESSION_ID_CODE_UNITS = 1024

type ConsoleEvent = {
  type?: string
  args?: { value?: unknown; description?: unknown }[]
  timestamp?: number
  stackTrace?: { callFrames?: { url?: string; lineNumber?: number }[] }
}

type InterceptedRequestEvent = {
  requestId: string
  request: { url?: string; method?: string; headers?: Record<string, string> }
  resourceType?: string
}

export function buildBoundedCdpConsoleEntry(event: ConsoleEvent): BrowserConsoleEntry {
  const parts: string[] = []
  let remaining = CDP_MAX_CONSOLE_TEXT_CODE_UNITS
  const args = event.args ?? []
  const argumentCount = Math.min(args.length, CDP_MAX_CONSOLE_ARGUMENTS)
  for (let index = 0; index < argumentCount && remaining > 0; index++) {
    if (index > 0) {
      parts.push(' ')
      remaining -= 1
      if (remaining <= 0) {
        break
      }
    }
    const raw = consoleArgumentText(args[index])
    const value = truncateCdpField(raw, remaining)
    parts.push(value)
    remaining -= value.length
  }
  return {
    level: truncateCdpField(event.type ?? 'log', CDP_MAX_LEVEL_CODE_UNITS),
    text: parts.join(''),
    timestamp: event.timestamp ?? Date.now(),
    url: truncateOptionalCdpField(
      event.stackTrace?.callFrames?.[0]?.url,
      CDP_MAX_CAPTURE_URL_CODE_UNITS
    ),
    line: event.stackTrace?.callFrames?.[0]?.lineNumber
  }
}

export function buildBoundedCdpNetworkEntry(
  response: { url?: string; status?: number; mimeType?: string },
  timestamp?: number
): BrowserNetworkEntry {
  return {
    url: truncateCdpField(response.url ?? '', CDP_MAX_CAPTURE_URL_CODE_UNITS),
    method: '',
    status: response.status ?? 0,
    mimeType: truncateCdpField(response.mimeType ?? '', CDP_MAX_MIME_TYPE_CODE_UNITS),
    size: 0,
    timestamp: timestamp ?? Date.now()
  }
}

export function buildBoundedCdpInterceptedRequest(
  event: InterceptedRequestEvent
): BrowserInterceptedRequest | null {
  let remaining = CDP_MAX_INTERCEPTED_METADATA_CODE_UNITS
  const reserve = (value: string): boolean => {
    if (value.length > remaining) {
      return false
    }
    remaining -= value.length
    return true
  }
  const url = event.request.url ?? ''
  const method = event.request.method ?? 'GET'
  const resourceType = event.resourceType ?? 'Other'
  if (![event.requestId, url, method, resourceType].every(reserve)) {
    return null
  }

  const headers: Record<string, string> = Object.create(null) as Record<string, string>
  let headerCount = 0
  for (const name in event.request.headers ?? {}) {
    if (!Object.hasOwn(event.request.headers ?? {}, name)) {
      continue
    }
    const value = event.request.headers![name]
    if (
      headerCount >= CDP_MAX_INTERCEPTED_HEADERS ||
      typeof value !== 'string' ||
      !reserve(name) ||
      !reserve(value)
    ) {
      return null
    }
    headers[name] = value
    headerCount += 1
  }
  return { id: event.requestId, url, method, headers, resourceType }
}

export function isBoundedCdpIframeSession(frameId: string, sessionId: string): boolean {
  return (
    frameId.length <= CDP_MAX_SESSION_ID_CODE_UNITS &&
    sessionId.length <= CDP_MAX_SESSION_ID_CODE_UNITS
  )
}

function consoleArgumentText(arg: { value?: unknown; description?: unknown } | undefined): string {
  const value = arg?.value ?? arg?.description ?? ''
  if (typeof value === 'string') {
    return value
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value)
  }
  return ''
}

function truncateOptionalCdpField(
  value: string | undefined,
  maxLength: number
): string | undefined {
  return value === undefined ? undefined : truncateCdpField(value, maxLength)
}

function truncateCdpField(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value
  }
  return `${value.slice(0, Math.max(0, maxLength - 1))}…`
}
