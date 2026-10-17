import type {
  AiVaultScanIssue,
  AiVaultScope,
  AiVaultSession
} from '../../../src/shared/ai-vault-types'

export const MOBILE_AI_VAULT_INITIAL_LIMIT = 30
export const MOBILE_AI_VAULT_SESSION_LIMIT = 250

const MAX_CACHED_ENTRIES = 20

export type MobileAiVaultCacheEntry = {
  sessions: AiVaultSession[]
  issues: AiVaultScanIssue[]
  fingerprint?: string
  limit: number
}

export type MobileAiVaultScanReply = {
  sessions: unknown[]
  issues: unknown[]
  fingerprint?: string
  unchanged?: boolean
}

export type MobileAiVaultLoadPlan =
  | {
      kind: 'revalidate'
      limit: typeof MOBILE_AI_VAULT_SESSION_LIMIT
      afterFingerprint: string
    }
  | {
      kind: 'fill'
      limit: typeof MOBILE_AI_VAULT_SESSION_LIMIT
      afterFingerprint: string | null
      force: boolean
    }
  | {
      kind: 'stage'
      firstLimit: typeof MOBILE_AI_VAULT_INITIAL_LIMIT
      thenLimit: typeof MOBILE_AI_VAULT_SESSION_LIMIT
    }

const mobileAiVaultMemoryCache = new Map<string, MobileAiVaultCacheEntry>()

export function getMobileAiVaultCacheKey(
  hostId: string,
  worktreeId: string,
  scope: AiVaultScope
): string {
  return `${hostId}:${worktreeId}:${scope}`
}

export function clearMobileAiVaultMemoryCache(): void {
  mobileAiVaultMemoryCache.clear()
}

export function readMobileAiVaultCache(key: string): MobileAiVaultCacheEntry | null {
  const entry = mobileAiVaultMemoryCache.get(key)
  if (!entry) {
    return null
  }
  // Why: Map.get does not refresh LRU order; delete+set so hits stay newest.
  mobileAiVaultMemoryCache.delete(key)
  mobileAiVaultMemoryCache.set(key, entry)
  return entry
}

export function writeMobileAiVaultCache(key: string, entry: MobileAiVaultCacheEntry): void {
  const existing = mobileAiVaultMemoryCache.get(key)
  // Why: a late limit=30 reply must not shrink a limit=250 snapshot already on screen.
  if (existing && existing.limit > entry.limit) {
    return
  }
  mobileAiVaultMemoryCache.delete(key)
  mobileAiVaultMemoryCache.set(key, entry)
  while (mobileAiVaultMemoryCache.size > MAX_CACHED_ENTRIES) {
    const oldest = mobileAiVaultMemoryCache.keys().next().value
    if (oldest === undefined) {
      break
    }
    mobileAiVaultMemoryCache.delete(oldest)
  }
}

/** Cached rows are safe to paint only when scoped tabs already have narrowing paths. */
export function canPaintMobileAiVaultCache(
  scope: AiVaultScope,
  scopeFilterPaths: readonly string[]
): boolean {
  return scope === 'all' || scopeFilterPaths.length > 0
}

export function planMobileAiVaultLoad(
  cached: MobileAiVaultCacheEntry | null,
  force: boolean
): MobileAiVaultLoadPlan {
  // Why: force must hit depth=250 only — a forced depth=30 would overwrite the host's shared scan cache.
  if (force) {
    return {
      kind: 'fill',
      limit: MOBILE_AI_VAULT_SESSION_LIMIT,
      afterFingerprint: null,
      force: true
    }
  }
  if (cached && cached.limit >= MOBILE_AI_VAULT_SESSION_LIMIT) {
    if (typeof cached.fingerprint === 'string' && cached.fingerprint.length > 0) {
      return {
        kind: 'revalidate',
        limit: MOBILE_AI_VAULT_SESSION_LIMIT,
        afterFingerprint: cached.fingerprint
      }
    }
    return {
      kind: 'fill',
      limit: MOBILE_AI_VAULT_SESSION_LIMIT,
      afterFingerprint: null,
      force: false
    }
  }
  if (cached && cached.limit > 0) {
    return {
      kind: 'fill',
      limit: MOBILE_AI_VAULT_SESSION_LIMIT,
      afterFingerprint: null,
      force: false
    }
  }
  return {
    kind: 'stage',
    firstLimit: MOBILE_AI_VAULT_INITIAL_LIMIT,
    thenLimit: MOBILE_AI_VAULT_SESSION_LIMIT
  }
}

export function applyMobileAiVaultScan(args: {
  previous: MobileAiVaultCacheEntry | null
  requestedLimit: number
  reply: MobileAiVaultScanReply
}): MobileAiVaultCacheEntry | 'keep' | 'refetch-full' {
  if (args.reply.unchanged === true) {
    if (
      args.previous &&
      typeof args.previous.fingerprint === 'string' &&
      args.reply.fingerprint === args.previous.fingerprint
    ) {
      return 'keep'
    }
    return 'refetch-full'
  }
  if (args.previous && args.previous.limit > args.requestedLimit) {
    return 'keep'
  }
  // Why: fewer rows than requested means the host had nothing deeper; treat as full depth.
  const limit =
    args.reply.sessions.length < args.requestedLimit
      ? MOBILE_AI_VAULT_SESSION_LIMIT
      : args.requestedLimit
  return {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: same reader as the hook; rows stay host AiVaultSession records echoed on resume.
    sessions: args.reply.sessions as AiVaultSession[],
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: same reader; issues are only counted, never read member-wise.
    issues: args.reply.issues as AiVaultScanIssue[],
    fingerprint: typeof args.reply.fingerprint === 'string' ? args.reply.fingerprint : undefined,
    limit
  }
}

export async function executeMobileAiVaultPlan(args: {
  cacheKey: string
  cached: MobileAiVaultCacheEntry | null
  plan: MobileAiVaultLoadPlan
  isCurrent: () => boolean
  scan: (params: { limit: number; force: boolean; afterFingerprint: string | null }) => Promise<MobileAiVaultScanReply>
  onPublish: (entry: MobileAiVaultCacheEntry) => void
}): Promise<void> {
  const { cacheKey, cached, plan, isCurrent, scan, onPublish } = args

  const applyAndPublish = (
    previous: MobileAiVaultCacheEntry | null,
    requestedLimit: number,
    reply: MobileAiVaultScanReply
  ): MobileAiVaultCacheEntry | 'keep' | 'refetch-full' => {
    const applied = applyMobileAiVaultScan({ previous, requestedLimit, reply })
    if (applied === 'keep' || applied === 'refetch-full') {
      return applied
    }
    writeMobileAiVaultCache(cacheKey, applied)
    if (isCurrent()) {
      onPublish(applied)
    }
    return applied
  }

  if (plan.kind === 'revalidate') {
    let reply = await scan({
      limit: plan.limit,
      force: false,
      afterFingerprint: plan.afterFingerprint
    })
    if (!isCurrent()) {
      return
    }
    let applied = applyAndPublish(cached, plan.limit, reply)
    if (applied === 'refetch-full') {
      reply = await scan({ limit: plan.limit, force: false, afterFingerprint: null })
      if (!isCurrent()) {
        return
      }
      applyAndPublish(cached, plan.limit, reply)
    }
    return
  }

  if (plan.kind === 'fill') {
    const reply = await scan({
      limit: plan.limit,
      force: plan.force,
      afterFingerprint: plan.afterFingerprint
    })
    if (!isCurrent()) {
      return
    }
    applyAndPublish(cached, plan.limit, reply)
    return
  }

  const firstReply = await scan({
    limit: plan.firstLimit,
    force: false,
    afterFingerprint: null
  })
  if (!isCurrent()) {
    return
  }
  const afterFirst = applyAndPublish(cached, plan.firstLimit, firstReply)
  if (afterFirst === 'keep' || afterFirst === 'refetch-full' || afterFirst.limit >= plan.thenLimit) {
    return
  }
  const secondReply = await scan({
    limit: plan.thenLimit,
    force: false,
    afterFingerprint: null
  })
  if (!isCurrent()) {
    return
  }
  applyAndPublish(afterFirst, plan.thenLimit, secondReply)
}
