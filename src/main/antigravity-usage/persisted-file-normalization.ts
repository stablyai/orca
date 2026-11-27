import type { AntigravityUsagePersistedFile } from './types'

/** Backfill old caches in both the main process and scan worker. */
export function normalizeAntigravityUsagePersistedFiles(
  files: AntigravityUsagePersistedFile[] | undefined
): AntigravityUsagePersistedFile[] {
  return (files ?? []).map((file) => ({
    ...file,
    ...(Array.isArray(file.sessions) &&
    Array.isArray(file.dailyAggregates) &&
    typeof file.conversationId === 'string' &&
    typeof file.effectiveSessionId === 'string'
      ? {}
      : { sessions: [], dailyAggregates: [], mtimeMs: -1, size: -1 }),
    conversationId: file.conversationId ?? '',
    effectiveSessionId: file.effectiveSessionId ?? file.conversationId ?? '',
    effectiveCwd: file.effectiveCwd ?? null,
    openingPrompt: file.openingPrompt ?? null,
    childConversationIds: Array.isArray(file.childConversationIds) ? file.childConversationIds : [],
    ownedEventKeys: file.ownedEventKeys ?? [],
    hasDeferredClaims: file.hasDeferredClaims ?? true
  }))
}
