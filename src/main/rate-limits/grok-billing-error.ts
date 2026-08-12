import type { UsageRateLimitMetadata } from '../../shared/rate-limit-types'

export type GrokBillingHttpFailure = {
  status: 'unavailable' | 'error'
  error: string
  usageMetadata?: UsageRateLimitMetadata
}

export function isMissingPersonalTeamError(detail: string | null): boolean {
  return Boolean(detail && /no personal team/i.test(detail))
}

export function parseGrokBillingErrorDetail(raw: string): string | null {
  const text = raw.trim()
  if (!text) {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null || !('error' in parsed)) {
      return null
    }
    const error = (parsed as { error?: unknown }).error
    return typeof error === 'string' && error.trim() ? error.trim() : null
  } catch {
    return null
  }
}

// Why: team/org Grok CLI sessions 412 because GetGrokCreditsConfig
// resolve_personal_team_id() has nothing to resolve — not a transient
// refresh failure, and not an auth problem (#14060).
export function classifyGrokBillingHttpFailure(
  status: number,
  rawBody: string
): GrokBillingHttpFailure {
  const detail = parseGrokBillingErrorDetail(rawBody)
  if (status === 412 && isMissingPersonalTeamError(detail)) {
    return {
      status: 'unavailable',
      error:
        'Grok usage is unavailable for team accounts — the billing API requires a personal team',
      usageMetadata: { failureKind: 'usage-unavailable', source: 'oauth' }
    }
  }
  const suffix = detail ? `: ${detail}` : ''
  return {
    status: 'error',
    error: `Grok usage request failed (HTTP ${status})${suffix}`
  }
}

export async function readGrokBillingErrorBody(res: Response): Promise<string> {
  try {
    return await res.text()
  } catch {
    return ''
  }
}
