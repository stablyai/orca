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
    // The session is real; the account simply is not entitled to what was asked for.
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
