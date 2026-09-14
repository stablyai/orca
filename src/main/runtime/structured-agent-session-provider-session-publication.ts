// Publishing the provider conversation id onto a structured chat's session tab.
//
// The tab is minted before the provider has proven a conversation, so the id arrives late. These
// helpers stamp it on when it does: the renderer's AI Vault title pipeline keys on it, and without
// it a chat keeps the generic label for the life of the session.

import type { RuntimeMobileSessionAgentTab } from '../../shared/runtime-mobile-session-tab-contracts'
import type { RuntimeMobileSessionTabsSnapshot } from '../../shared/runtime-types'
import { headStructuredProviderSessionId } from '../native-chat/agent-session-wire/structured-provider-session-ownership'
import { readStructuredAgentSessionRecord } from './structured-worker-authority'

/** Head of the record's handle chain, so a forked session is never presented as its origin. */
export function structuredAgentSessionProviderSessionId(sessionId: string): string | null {
  const record = readStructuredAgentSessionRecord(sessionId)
  return record ? headStructuredProviderSessionId(record) : null
}

/** Omit rather than blank: an unproven identity is unknown, not an empty conversation id. */
export function withStructuredProviderSessionId(
  tab: RuntimeMobileSessionAgentTab,
  providerSessionId: string | null
): RuntimeMobileSessionAgentTab {
  if (providerSessionId === (tab.providerSessionId ?? null)) {
    return tab
  }
  if (providerSessionId) {
    return { ...tab, providerSessionId }
  }
  const { providerSessionId: _cleared, ...withoutProviderSession } = tab
  return withoutProviderSession
}

/**
 * Re-reads every structured chat tab's provider conversation from the durable record. Returns the
 * same array when nothing moved, so an unchanged pass cannot bump the snapshot version.
 */
export function refreshStructuredProviderSessions(
  tabs: RuntimeMobileSessionTabsSnapshot['tabs'],
  resolve: (sessionId: string) => string | null = structuredAgentSessionProviderSessionId
): RuntimeMobileSessionTabsSnapshot['tabs'] {
  let changed = false
  const refreshed = tabs.map((tab) => {
    if (tab.type !== 'agent-session') {
      return tab
    }
    const next = withStructuredProviderSessionId(tab, resolve(tab.sessionId))
    changed ||= next !== tab
    return next
  })
  return changed ? refreshed : tabs
}
