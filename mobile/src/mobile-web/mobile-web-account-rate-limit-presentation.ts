import { MOBILE_WEB_ACCOUNT_LIMIT } from '../../../src/shared/mobile-web/account-operation-contract'

type Provider = 'claude' | 'codex'

export function mobileWebInactiveAccountUsage(value: unknown, provider: Provider) {
  if (!Array.isArray(value)) {
    return []
  }
  return value.slice(0, MOBILE_WEB_ACCOUNT_LIMIT).flatMap((entry) => {
    if (!isRecord(entry)) {
      return []
    }
    const accountId = boundedRequiredText(entry.accountId, 256)
    if (!accountId) {
      return []
    }
    return [
      {
        accountId,
        rateLimits: mobileWebProviderRateLimits(entry.rateLimits, provider),
        updatedAt: boundedTimestamp(entry.updatedAt),
        isFetching: entry.isFetching === true
      }
    ]
  })
}

export function mobileWebProviderRateLimits(value: unknown, provider: Provider) {
  if (!isRecord(value)) {
    return null
  }
  return {
    provider,
    session: rateLimitWindow(value.session),
    weekly: rateLimitWindow(value.weekly),
    ...optionalWindowField('fableWeekly', value.fableWeekly),
    ...optionalWindowField('monthly', value.monthly),
    ...optionalBucketsField(value.buckets),
    ...optionalResetCreditsField(value.rateLimitResetCredits),
    updatedAt: boundedTimestamp(value.updatedAt),
    error: boundedNullableText(value.error, 512),
    status: rateLimitStatus(value.status)
  }
}

function rateLimitWindow(value: unknown) {
  if (!isRecord(value) || !Number.isFinite(value.usedPercent)) {
    return null
  }
  return {
    usedPercent: Math.min(100, Math.max(0, Number(value.usedPercent))),
    windowMinutes: boundedInteger(value.windowMinutes, 1_000_000),
    resetsAt: value.resetsAt === null ? null : boundedTimestamp(value.resetsAt),
    resetDescription: boundedNullableText(value.resetDescription, 240)
  }
}

function optionalWindowField(name: string, value: unknown) {
  return value === undefined ? {} : { [name]: rateLimitWindow(value) }
}

function optionalBucketsField(value: unknown) {
  if (!Array.isArray(value)) {
    return {}
  }
  const buckets = value.slice(0, MOBILE_WEB_ACCOUNT_LIMIT).flatMap((bucket) => {
    if (!isRecord(bucket)) {
      return []
    }
    const name = boundedRequiredText(bucket.name, 240)
    const window = rateLimitWindow(bucket)
    return name && window ? [{ ...window, name }] : []
  })
  return { buckets }
}

function optionalResetCreditsField(value: unknown) {
  if (value === undefined) {
    return {}
  }
  if (!isRecord(value)) {
    return { rateLimitResetCredits: null }
  }
  const credits = Array.isArray(value.credits)
    ? value.credits.slice(0, MOBILE_WEB_ACCOUNT_LIMIT).flatMap((credit) => {
        if (!isRecord(credit)) {
          return []
        }
        const status = boundedRequiredText(credit.status, 64)
        return status
          ? [
              {
                status,
                expiresAt: nullableTimestamp(credit.expiresAt),
                grantedAt: nullableTimestamp(credit.grantedAt)
              }
            ]
          : []
      })
    : undefined
  return {
    rateLimitResetCredits: {
      availableCount: boundedInteger(value.availableCount, Number.MAX_SAFE_INTEGER),
      ...(value.totalEarnedCount === undefined
        ? {}
        : {
            totalEarnedCount: boundedInteger(value.totalEarnedCount, Number.MAX_SAFE_INTEGER)
          }),
      ...(value.nextExpiresAt === undefined
        ? {}
        : { nextExpiresAt: nullableTimestamp(value.nextExpiresAt) }),
      ...(credits ? { credits } : {})
    }
  }
}

function nullableTimestamp(value: unknown): number | null {
  return value === null ? null : boundedTimestamp(value)
}

function rateLimitStatus(value: unknown) {
  return value === 'idle' ||
    value === 'fetching' ||
    value === 'ok' ||
    value === 'error' ||
    value === 'unavailable'
    ? value
    : 'unavailable'
}

function boundedInteger(value: unknown, maximum: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(maximum, Math.max(0, Math.round(value)))
    : 0
}

function boundedTimestamp(value: unknown): number {
  return boundedInteger(value, Number.MAX_SAFE_INTEGER)
}

function boundedRequiredText(value: unknown, maximum: number): string | null {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, maximum) : null
}

function boundedNullableText(value: unknown, maximum: number): string | null {
  return typeof value === 'string' ? value.slice(0, maximum) : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
