import type {
  ProviderRateLimits,
  RateLimitBucket,
  RateLimitWindow
} from '../../shared/rate-limit-types'

export type AntigravityFamily = 'claude' | 'gemini'
export type AntigravityWindowSlot = '5h' | 'weekly'

export type AntigravitySlotValue = {
  remaining: number
  reset: string
}

export type AntigravityQuotaSummaryBucket = {
  bucketId?: string | null
  window?: string | null
  remainingFraction?: number | null
  resetTime?: string | null
}

export type AntigravityQuotaSummaryGroup = {
  displayName?: string | null
  buckets?: AntigravityQuotaSummaryBucket[] | null
}

export type AntigravityQuotaSummaryResponse = {
  groups?: AntigravityQuotaSummaryGroup[] | null
}

export type AntigravityModelQuotaInfo = {
  remainingFraction?: number | null
  resetTime?: string | null
}

export type AntigravityModelsResponse = {
  models?: Record<string, { quotaInfo?: AntigravityModelQuotaInfo | null }> | null
}

export type AntigravitySlotKey = `${AntigravityFamily}:${AntigravityWindowSlot}`

export const ANTIGRAVITY_BUCKET_ORDER: readonly {
  family: AntigravityFamily
  slot: AntigravityWindowSlot
  name: string
  windowMinutes: number
}[] = [
  { family: 'claude', slot: '5h', name: 'Claude', windowMinutes: 300 },
  { family: 'claude', slot: 'weekly', name: 'Claude W', windowMinutes: 10_080 },
  { family: 'gemini', slot: '5h', name: 'Gemini', windowMinutes: 300 },
  { family: 'gemini', slot: 'weekly', name: 'Gemini W', windowMinutes: 10_080 }
]

export function antigravitySlotKey(
  family: AntigravityFamily,
  slot: AntigravityWindowSlot
): AntigravitySlotKey {
  return `${family}:${slot}`
}

// Why: the group label is authoritative; older responses may only identify the family in bucketId.
export function antigravityFamilyForGroup(
  groupName: string,
  bucketId: string
): AntigravityFamily | null {
  const group = groupName.toLowerCase()
  if (group.includes('gemini')) {
    return 'gemini'
  }
  if (group.includes('claude') || group.includes('gpt') || group.includes('third')) {
    return 'claude'
  }

  const bucket = bucketId.toLowerCase()
  if (bucket.includes('gemini')) {
    return 'gemini'
  }
  if (bucket.includes('claude') || bucket.includes('3p')) {
    return 'claude'
  }
  return null
}

export function antigravityWindowSlot(window: string): AntigravityWindowSlot | null {
  switch (window.trim().toLowerCase()) {
    case '5h':
      return '5h'
    case 'weekly':
      return 'weekly'
    default:
      return null
  }
}

export function remainingToUsedPercent(remaining: number): number {
  const clamped = Math.min(1, Math.max(0, remaining))
  return Math.min(100, Math.max(0, Math.round((1 - clamped) * 100)))
}

export function upsertAntigravitySlot(
  slots: Map<AntigravitySlotKey, AntigravitySlotValue>,
  family: AntigravityFamily,
  slot: AntigravityWindowSlot,
  remaining: number,
  reset: string
): void {
  const key = antigravitySlotKey(family, slot)
  const nextRemaining = Math.min(1, Math.max(0, remaining))
  const existing = slots.get(key)
  if (!existing) {
    slots.set(key, { remaining: nextRemaining, reset })
    return
  }
  // Why: keep the most constrained remaining fraction for the family/window.
  if (nextRemaining < existing.remaining) {
    slots.set(key, {
      remaining: nextRemaining,
      reset: reset.length > 0 ? reset : existing.reset
    })
  }
}

export function populateAntigravitySlotsFromSummary(
  slots: Map<AntigravitySlotKey, AntigravitySlotValue>,
  summary: AntigravityQuotaSummaryResponse
): void {
  for (const group of summary.groups ?? []) {
    const groupName = group.displayName ?? ''
    for (const bucket of group.buckets ?? []) {
      const bucketId = bucket.bucketId ?? ''
      const family = antigravityFamilyForGroup(groupName, bucketId)
      if (!family) {
        continue
      }
      const slot = antigravityWindowSlot(bucket.window ?? '')
      if (!slot) {
        continue
      }
      // Why: metadata-only buckets do not prove exhaustion and must not become a false 100% bar.
      if (typeof bucket.remainingFraction !== 'number') {
        continue
      }
      const remaining = bucket.remainingFraction
      const reset = bucket.resetTime ?? ''
      upsertAntigravitySlot(slots, family, slot, remaining, reset)
    }
  }
}

export function populateAntigravity5hFromModelsIfMissing(
  slots: Map<AntigravitySlotKey, AntigravitySlotValue>,
  models: AntigravityModelsResponse
): void {
  let claude: AntigravitySlotValue | null = null
  let gemini: AntigravitySlotValue | null = null

  for (const [name, info] of Object.entries(models.models ?? {})) {
    const family: AntigravityFamily | null = name.startsWith('claude')
      ? 'claude'
      : name.startsWith('gemini')
        ? 'gemini'
        : null
    if (!family) {
      continue
    }
    const qi = info.quotaInfo
    if (typeof qi?.remainingFraction !== 'number') {
      continue
    }
    const remaining = Math.min(1, Math.max(0, qi.remainingFraction))
    const reset = qi?.resetTime ?? ''
    const target = family === 'claude' ? claude : gemini
    if (!target || remaining < target.remaining) {
      const next = { remaining, reset: reset.length > 0 ? reset : (target?.reset ?? '') }
      if (family === 'claude') {
        claude = next
      } else {
        gemini = next
      }
    }
  }

  if (!slots.has(antigravitySlotKey('claude', '5h')) && claude) {
    upsertAntigravitySlot(slots, 'claude', '5h', claude.remaining, claude.reset)
  }
  if (!slots.has(antigravitySlotKey('gemini', '5h')) && gemini) {
    upsertAntigravitySlot(slots, 'gemini', '5h', gemini.remaining, gemini.reset)
  }
}

function slotToWindow(value: AntigravitySlotValue, windowMinutes: number): RateLimitWindow {
  const resetsAtTime = value.reset ? new Date(value.reset).getTime() : Number.NaN
  return {
    usedPercent: remainingToUsedPercent(value.remaining),
    windowMinutes,
    resetsAt: !Number.isNaN(resetsAtTime) ? resetsAtTime : null,
    resetDescription: null
  }
}

export function antigravitySlotsToBuckets(
  slots: Map<AntigravitySlotKey, AntigravitySlotValue>
): RateLimitBucket[] {
  const buckets: RateLimitBucket[] = []
  for (const entry of ANTIGRAVITY_BUCKET_ORDER) {
    const value = slots.get(antigravitySlotKey(entry.family, entry.slot))
    if (!value) {
      continue
    }
    buckets.push({
      name: entry.name,
      ...slotToWindow(value, entry.windowMinutes)
    })
  }
  return buckets
}

export function deriveAntigravitySessionWeekly(buckets: RateLimitBucket[]): {
  session: RateLimitWindow | null
  weekly: RateLimitWindow | null
} {
  const sessionCandidates = buckets.filter((b) => b.windowMinutes === 300)
  const weeklyCandidates = buckets.filter((b) => b.windowMinutes === 10_080)
  const pickWorst = (list: RateLimitBucket[]): RateLimitWindow | null => {
    if (list.length === 0) {
      return null
    }
    const worst = list.reduce((a, b) => (b.usedPercent > a.usedPercent ? b : a))
    return {
      usedPercent: worst.usedPercent,
      windowMinutes: worst.windowMinutes,
      resetsAt: worst.resetsAt,
      resetDescription: worst.resetDescription
    }
  }
  return {
    session: pickWorst(sessionCandidates),
    weekly: pickWorst(weeklyCandidates)
  }
}

export function buildAntigravityRateLimitsFromQuota(input: {
  summary: AntigravityQuotaSummaryResponse | null
  models: AntigravityModelsResponse | null
  updatedAt?: number
}): ProviderRateLimits {
  const slots = new Map<AntigravitySlotKey, AntigravitySlotValue>()
  if (input.summary) {
    populateAntigravitySlotsFromSummary(slots, input.summary)
  }
  if (input.models) {
    populateAntigravity5hFromModelsIfMissing(slots, input.models)
  }
  const buckets = antigravitySlotsToBuckets(slots)
  const { session, weekly } = deriveAntigravitySessionWeekly(buckets)
  return {
    provider: 'antigravity',
    session,
    weekly,
    buckets,
    updatedAt: input.updatedAt ?? Date.now(),
    error:
      buckets.length === 0
        ? 'Antigravity connected, but no Claude/Gemini quota windows were returned'
        : null,
    status: buckets.length === 0 ? 'error' : 'ok',
    usageMetadata: {
      source: 'oauth',
      credentialSource: 'windows-credential-manager'
    }
  }
}
