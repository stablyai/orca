import type { UsageRateLimitFailureKind } from '../../shared/rate-limit-types'
import { stripTerminalControl } from '../../shared/terminal-control-stripping'
import { redactString } from '../observability/redactor'

const AGY_ERROR_PREFIX = 'AGY_ERROR:'

const SIGNED_OUT_PHRASES = [
  'not logged into antigravity',
  'not logged in',
  'not signed in',
  'not authenticated',
  'not-authenticated',
  'unauthenticated',
  'run agy login',
  'please sign in',
  'please log in',
  'sign in to antigravity',
  'no credentials',
  'authentication required'
] as const

const AGY_MESSAGE_MAX_LENGTH = 160
// Start at a boundary to avoid quadratic retries inside long, unbroken diagnostics.
const EMAIL_PATTERN = /(^|[\s@])[^\s@]+@[^\s@]+\.[^\s@]+/g
const TOKEN_LIKE_PATTERN = /[\w-]{32,}/g

export type AntigravityUsageFailure = {
  failureKind: UsageRateLimitFailureKind
  /** Missing authentication requires sign-in guidance. */
  signedOut: boolean
}

type StructuredAgyError = { status?: unknown; error_code?: unknown }

function parseStructuredErrors(output: string): StructuredAgyError[] {
  const parsed: StructuredAgyError[] = []
  for (const line of output.split('\n')) {
    const index = line.indexOf(AGY_ERROR_PREFIX)
    if (index === -1) {
      continue
    }
    const payload = line.slice(index + AGY_ERROR_PREFIX.length).trim()
    if (!payload.startsWith('{')) {
      continue
    }
    try {
      const value: unknown = JSON.parse(payload)
      if (typeof value === 'object' && value !== null) {
        parsed.push(value)
      }
    } catch {
      continue
    }
  }
  return parsed
}

function classifyStructured(error: StructuredAgyError): AntigravityUsageFailure | null {
  const status = typeof error.status === 'string' ? error.status.toUpperCase() : ''
  const code = typeof error.error_code === 'number' ? error.error_code : null
  if (status === 'UNAUTHENTICATED' || code === 401) {
    return { failureKind: 'missing-credentials', signedOut: true }
  }
  if (status === 'PERMISSION_DENIED' || code === 403) {
    return { failureKind: 'no-subscription', signedOut: false }
  }
  if (status === 'RESOURCE_EXHAUSTED' || code === 429) {
    return { failureKind: 'rate-limited', signedOut: false }
  }
  if (code !== null && code >= 500 && code < 600) {
    return { failureKind: 'server', signedOut: false }
  }
  return null
}

// Structured errors outrank prose; an unknown diagnostic supplies no failure cause.
export function classifyAntigravityUsageFailure(output: string): AntigravityUsageFailure | null {
  for (const error of parseStructuredErrors(output)) {
    const classified = classifyStructured(error)
    if (classified) {
      return classified
    }
  }
  const lowered = output.toLowerCase()
  if (SIGNED_OUT_PHRASES.some((phrase) => lowered.includes(phrase))) {
    return { failureKind: 'missing-credentials', signedOut: true }
  }
  return null
}

// agy 1.4.2 prints this after opening a browser OAuth page, then waits up to 60 s for it.
export function stderrShowsInteractiveSignIn(stderr: string): boolean {
  return stderr.includes('Authentication required. Please visit the URL')
}

/** One bounded line of agy's error text, safe to show in the status bar. */
export function formatAgyErrorForDisplay(text: string): string | null {
  const line = redactString(stripTerminalControl(text))
    .replace(/\s+/g, ' ')
    .trim()
    .replace(EMAIL_PATTERN, '$1[email]')
    .replace(TOKEN_LIKE_PATTERN, '[redacted]')
  if (!line) {
    return null
  }
  const chars = Array.from(line)
  if (chars.length <= AGY_MESSAGE_MAX_LENGTH) {
    return line
  }
  const kept = chars.slice(0, AGY_MESSAGE_MAX_LENGTH - 1).join('')
  return `${kept.trimEnd()}…`
}
