// ---------------------------------------------------------------------------
// Browser action recorder — tagged console line parsing
//
// The in-page capture script reports interactions and network requests as
// tagged console.debug lines; these parsers turn them back into structured
// payloads, with secret-shaped request values redacted.
// ---------------------------------------------------------------------------

import { BROWSER_RECORDER_INTERACTION_TAG } from '../../shared/browser-recorder-automation'
import type { BrowserRecorderInteractionKind } from '../../shared/browser-recorder-automation'

/** Raw payload carried inside a tagged console.debug line from the page. */
export type BrowserRecorderInteractionPayload = {
  type: BrowserRecorderInteractionKind
  x?: number
  y?: number
  target?: string
  tagName?: string
  key?: string
  text?: string
  code?: string
}

/** Raw request payload carried inside a tagged console.debug line. */
export type BrowserRecorderRequestPayload = {
  type: 'request'
  method?: string
  url?: string
  body?: string
  status?: number | null
  durationMs?: number | null
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
  try {
    const parsed = JSON.parse(json) as Partial<BrowserRecorderInteractionPayload>
    if (
      parsed.type !== 'click' &&
      parsed.type !== 'keydown' &&
      parsed.type !== 'type' &&
      parsed.type !== 'scroll' &&
      parsed.type !== 'hover'
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
      code: typeof parsed.code === 'string' ? parsed.code.slice(0, 40) : undefined
    }
  } catch {
    return null
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
      durationMs: typeof parsed.durationMs === 'number' ? Math.round(parsed.durationMs) : null
    }
  } catch {
    return null
  }
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
