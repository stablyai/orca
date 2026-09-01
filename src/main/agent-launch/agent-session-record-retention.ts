// Retention + rehydrate filtering for the durable half of the host-private
// session record store (U5). Every bind/ingest/forget re-serializes and re-
// encrypts the WHOLE record set, so an unbounded set charges each launch for
// every session the host has ever recorded; the bound below is what keeps that
// per-launch cost flat.

import {
  getAgentSessionOwnershipKey,
  isResumableTuiAgent,
  normalizeAgentProviderSession
} from '../../shared/agent-session-resume'
// Type-only import: erased at runtime, so no import cycle with the store.
import type { HostSessionLaunchRecord } from './agent-session-record-store'

/** Retained durable resume records. Least-recently-updated first out, which is
 *  what keeps eviction safe: a record an in-flight launch still needs (a fresh
 *  bind, a rotation re-bind, or the rollback of either) was just stamped
 *  `updatedAt`, so it can never be the oldest. */
export const MAX_SESSION_RECORDS = 200

export function sessionRecordKeysToEvict(
  records: ReadonlyMap<string, HostSessionLaunchRecord>,
  max: number = MAX_SESSION_RECORDS
): string[] {
  if (records.size <= max) {
    return []
  }
  return [...records]
    .sort(([, a], [, b]) => a.updatedAt - b.updatedAt)
    .slice(0, records.size - max)
    .map(([ownershipKey]) => ownershipKey)
}

/** Rehydrated records minus the ownership keys forgotten since the last rebuild,
 *  so a deferred locked-keychain recovery merge cannot resurrect a session the
 *  owner already forgot. Malformed entries pass through — the rebuild drops them
 *  on shape regardless. */
export function recordsNotForgotten(
  records: Iterable<HostSessionLaunchRecord>,
  forgotten: ReadonlySet<string>
): HostSessionLaunchRecord[] {
  return [...records].filter((record) => {
    const providerSession = normalizeAgentProviderSession(record?.providerSession)
    if (!providerSession || typeof record?.worktreeId !== 'string') {
      return true
    }
    if (!isResumableTuiAgent(record.baseAgent)) {
      return true
    }
    return !forgotten.has(
      getAgentSessionOwnershipKey({
        worktreeId: record.worktreeId,
        baseAgent: record.baseAgent,
        providerSessionId: providerSession.id
      })
    )
  })
}
