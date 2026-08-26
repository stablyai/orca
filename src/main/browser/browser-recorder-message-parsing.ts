// Browser action recorder — tagged console line parsing (redacts secret-shaped values).

import {
  BROWSER_RECORDER_BUDGET,
  BROWSER_RECORDER_INTERACTION_TAG
} from '../../shared/browser-recorder-automation'
import type {
  BrowserRecorderElementProps,
  BrowserRecorderInteractionKind
} from '../../shared/browser-recorder-automation'

/** Raw payload carried inside a tagged console.debug line from the page. */
export type BrowserRecorderInteractionPayload = {
  type: BrowserRecorderInteractionKind
  x?: number
  y?: number
  target?: string
  tagName?: string
  key?: string
  text?: string
  value?: string
  clipboardAction?: 'copy' | 'paste' | 'cut'
  clipboardText?: string
  wsText?: string
  storageKey?: string
  storageValue?: string
  selectText?: string
  code?: string
  /** Element props (selector/classes/text/styles) for the interacted element. */
  el?: BrowserRecorderElementProps
}

/** Raw request payload carried inside a tagged console.debug line. */
export type BrowserRecorderRequestPayload = {
  type: 'request'
  method?: string
  url?: string
  body?: string
  status?: number | null
  durationMs?: number | null
  /** App call stack captured at request time, e.g. 'Error\n at stokKaydet (stok.php:142)…'. */
  origin?: string | null
  kind?: 'fetch' | 'xhr'
  /** Response body text captured by the in-page hook (already capped). */
  response?: string
  /** Full response size before capping (0 = unknown/not captured). */
  responseSize?: number
  /** True when the response exceeded the capture cap. */
  responseTruncated?: boolean
  /** 'html' when the response was schematized into visible text + controls. */
  responseSchema?: 'html' | 'text'
}

/**
 * Parses a page console line into an interaction payload, or null when the
 * line is not a tagged interaction (regular console output or a request).
 */
export function parseBrowserInteractionMessage(
  message: string
): BrowserRecorderInteractionPayload | null {
  if (!message.startsWith(BROWSER_RECORDER_INTERACTION_TAG)) {
    return null
  }
  const json = message.slice(BROWSER_RECORDER_INTERACTION_TAG.length).trim()
  // Why: the page hook caps its own output, but a hostile page could emit an
  // unbounded tagged line — reject it before JSON.parse runs.
  if (json.length > BROWSER_RECORDER_BUDGET.taggedLineMaxLength) {
    return null
  }
  try {
    const parsed = JSON.parse(json) as Partial<BrowserRecorderInteractionPayload>
    if (
      parsed.type !== 'click' &&
      parsed.type !== 'keydown' &&
      parsed.type !== 'type' &&
      parsed.type !== 'scroll' &&
      parsed.type !== 'hover' &&
      parsed.type !== 'change' &&
      parsed.type !== 'clipboard' &&
      parsed.type !== 'ws' &&
      parsed.type !== 'storage' &&
      parsed.type !== 'select_text'
    ) {
      return null
    }
    return {
      type: parsed.type,
      x: typeof parsed.x === 'number' ? Math.round(parsed.x) : undefined,
      y: typeof parsed.y === 'number' ? Math.round(parsed.y) : undefined,
      target: typeof parsed.target === 'string' ? parsed.target.slice(0, 100) : undefined,
      tagName: typeof parsed.tagName === 'string' ? parsed.tagName.slice(0, 40) : undefined,
      key: typeof parsed.key === 'string' ? parsed.key.slice(0, 40) : undefined,
      text: typeof parsed.text === 'string' ? parsed.text.slice(0, 200) : undefined,
      value: typeof parsed.value === 'string' ? parsed.value.slice(0, 200) : undefined,
      clipboardAction:
        parsed.clipboardAction === 'copy' ||
        parsed.clipboardAction === 'paste' ||
        parsed.clipboardAction === 'cut'
          ? parsed.clipboardAction
          : undefined,
      clipboardText:
        typeof parsed.clipboardText === 'string' ? parsed.clipboardText.slice(0, 200) : undefined,
      wsText: typeof parsed.wsText === 'string' ? parsed.wsText.slice(0, 200) : undefined,
      storageKey:
        typeof parsed.storageKey === 'string' ? parsed.storageKey.slice(0, 80) : undefined,
      storageValue:
        typeof parsed.storageValue === 'string' ? parsed.storageValue.slice(0, 200) : undefined,
      selectText:
        typeof parsed.selectText === 'string' ? parsed.selectText.slice(0, 200) : undefined,
      code: typeof parsed.code === 'string' ? parsed.code.slice(0, 40) : undefined,
      el: parseElementProps(parsed.el)
    }
  } catch {
    return null
  }
}

function parseElementProps(value: unknown): BrowserRecorderElementProps | undefined {
  if (!value || typeof value !== 'object') {
    return undefined
  }
  const record = value as Record<string, unknown>
  if (typeof record.selector !== 'string' && typeof record.tagName !== 'string') {
    return undefined
  }
  return {
    selector: typeof record.selector === 'string' ? record.selector.slice(0, 200) : '',
    tagName: typeof record.tagName === 'string' ? record.tagName.slice(0, 40) : '',
    classes: Array.isArray(record.classes)
      ? record.classes
          .filter((entry): entry is string => typeof entry === 'string')
          .slice(0, 5)
          .map((entry) => entry.slice(0, 40))
      : [],
    text: typeof record.text === 'string' ? record.text.slice(0, 60) : '',
    styles: Array.isArray(record.styles)
      ? record.styles
          .filter((entry): entry is string => typeof entry === 'string')
          .slice(0, 4)
          .map((entry) => entry.slice(0, 40))
      : []
  }
}

/**
 * Parses a page console line into a request payload, or null when the line is
 * not a tagged request event.
 */
export function parseBrowserRequestMessage(message: string): BrowserRecorderRequestPayload | null {
  if (!message.startsWith(BROWSER_RECORDER_INTERACTION_TAG)) {
    return null
  }
  const json = message.slice(BROWSER_RECORDER_INTERACTION_TAG.length).trim()
  // Why: same DoS guard as the interaction parser — reject before parsing.
  if (json.length > BROWSER_RECORDER_BUDGET.taggedLineMaxLength) {
    return null
  }
  try {
    const parsed = JSON.parse(json) as Partial<BrowserRecorderRequestPayload>
    if (parsed.type !== 'request') {
      return null
    }
    return {
      type: 'request',
      method: typeof parsed.method === 'string' ? parsed.method.slice(0, 10) : 'GET',
      url: typeof parsed.url === 'string' ? parsed.url.slice(0, 500) : '',
      body: typeof parsed.body === 'string' ? parsed.body : '',
      status: typeof parsed.status === 'number' ? parsed.status : null,
      durationMs: typeof parsed.durationMs === 'number' ? Math.round(parsed.durationMs) : null,
      origin: compactOriginStack(parsed.origin),
      kind: parsed.kind === 'fetch' ? 'fetch' : 'xhr',
      response: typeof parsed.response === 'string' ? parsed.response : '',
      responseSize: typeof parsed.responseSize === 'number' ? parsed.responseSize : 0,
      responseTruncated: parsed.responseTruncated === true,
      responseSchema: parsed.responseSchema === 'html' ? 'html' : 'text'
    }
  } catch {
    return null
  }
}

/**
 * Reduces a captured call stack to the app frames that initiated the request:
 * 'Error\n    at stokKaydet (stok.php:142)\n    at onclick (urun.php:10)' →
 * 'stokKaydet@stok.php:142 ← onclick@urun.php:10'. Hook frames (the injected
 * script) are skipped; eval/injected code frames are dropped.
 */
export function compactOriginStack(
  stack: string | null | undefined,
  maxLength = 120
): string | null {
  if (!stack) {
    return null
  }
  const frames: string[] = []
  for (const line of stack.split('\n')) {
    const match = /^\s*at\s+(.+?)\s*\((.+?)\)\s*$/.exec(line.trim())
    if (!match) {
      continue
    }
    const fn = match[1].trim()
    const location = match[2]
    if (
      fn.startsWith('<') ||
      fn === 'report' ||
      fn.startsWith('originStack') ||
      fn.includes('__orcaRecorder') ||
      location.includes('browser-page-capture') ||
      location.startsWith('<anonymous>') ||
      location.startsWith('eval at')
    ) {
      continue
    }
    // Chrome formats file:line; Firefox uses file:line:col — keep both.
    const shortLocation = location.replace(/:(\d+):\d+$/, ':$1')
    // Why: redact before appending the line suffix — a naive redact would swallow ':561'.
    const lineSuffix = /(:\d+)$/.exec(shortLocation)?.[1] ?? ''
    const base = lineSuffix ? shortLocation.slice(0, -lineSuffix.length) : shortLocation
    const safeLocation = `${redactRequestUrl(base)}${lineSuffix}`
    frames.push(fn.length > 40 ? `${fn.slice(0, 40)}…@${safeLocation}` : `${fn}@${safeLocation}`)
    if (frames.length >= 2) {
      break
    }
  }
  if (frames.length === 0) {
    return null
  }
  const joined = frames.join(' ← ')
  return joined.length > maxLength ? `${joined.slice(0, maxLength)}…` : joined
}

const SECRET_QUERY_PATTERN =
  /(password|passwd|secret|token|authorization|api[_-]?key|credential|csrf|sifre|parola|key)=[^&]*/i

/** Strips secret-shaped query parameters from a request URL. */
export function redactRequestUrl(url: string): string {
  const queryStart = url.indexOf('?')
  if (queryStart === -1) {
    return url
  }
  const base = url.slice(0, queryStart)
  const query = url.slice(queryStart + 1)
  const redacted = query
    .split('&')
    .map((part) => (SECRET_QUERY_PATTERN.test(part) ? part.replace(/=.*$/, '=***') : part))
    .join('&')
  return `${base}?${redacted}`
}

/** Redacts secret-shaped form values and caps a request body. */
export function redactPostData(body: string, maxLength: number): string {
  const redacted = body
    .split('&')
    .map((part) => (SECRET_QUERY_PATTERN.test(part) ? part.replace(/=.*$/, '=***') : part))
    .join('&')
  return redacted.length > maxLength ? `${redacted.slice(0, maxLength)}…` : redacted
}

// Why: response secrets are JSON "key":"value" pairs, not query parts — mask both shapes.
const SECRET_JSON_VALUE_PATTERN =
  /("(?:password|passwd|secret|token|authorization|api[_-]?key|credential|csrf|sifre|parola|key)"\s*:\s*")[^"]*(")/gi

/** Redacts secret-shaped JSON values and query parts inside a response body. */
export function redactResponseText(body: string): string {
  const jsonRedacted = body.replace(SECRET_JSON_VALUE_PATTERN, '$1***$2')
  return jsonRedacted
    .split('&')
    .map((part) => (SECRET_QUERY_PATTERN.test(part) ? part.replace(/=.*$/, '=***') : part))
    .join('&')
}
