// Shared signed-out and structured-error classification for `agy` CLI stdout/stderr.

import { stripAnsiEscapeSequences } from '../../shared/ansi-escape-sequences'
import type { UsageRateLimitFailureKind } from '../../shared/rate-limit-types'

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

export type AgyOutputFailure = {
  failureKind: UsageRateLimitFailureKind
  /** Missing authentication requires sign-in guidance. */
  signedOut: boolean
}

type StructuredAgyError = { status?: unknown; error_code?: unknown }

/** Extract structured `AGY_ERROR: {...}` JSON objects from `agy` output lines. */
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

/** Map a structured `AGY_ERROR` payload to its rate-limit or credential failure kind. */
function classifyStructured(error: StructuredAgyError): AgyOutputFailure | null {
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

/** Classify `agy` CLI output, giving structured `AGY_ERROR:` lines precedence over prose. */
export function classifyAgyOutputFailure(output: string): AgyOutputFailure | null {
  const plain = stripAnsiEscapeSequences(output)
  for (const error of parseStructuredErrors(plain)) {
    const classified = classifyStructured(error)
    if (classified) {
      return classified
    }
  }
  const lowered = plain.toLowerCase()
  if (SIGNED_OUT_PHRASES.some((phrase) => lowered.includes(phrase))) {
    return { failureKind: 'missing-credentials', signedOut: true }
  }
  return null
}

/** Detect the interactive browser OAuth prompt printed by `agy` when credentials are missing. */
export function stderrShowsInteractiveSignIn(stderr: string): boolean {
  return stripAnsiEscapeSequences(stderr).includes('Authentication required. Please visit the URL')
}

/** Return true when `agy` stdout/stderr indicates the host CLI is signed out. */
export function isAgySignedOutOutput(output: string): boolean {
  return (
    stderrShowsInteractiveSignIn(output) || classifyAgyOutputFailure(output)?.signedOut === true
  )
}
