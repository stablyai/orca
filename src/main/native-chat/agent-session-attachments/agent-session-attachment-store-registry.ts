// Keep RPC method imports from eagerly loading attachment-store filesystem dependencies.

import type { AgentJournalMessageItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentSessionAttachmentStore } from './agent-session-attachment-store'

/** Requires every store upload `body` references and claims it for `sessionId`, through the journal
 *  writer that owns claims and sweeps; throws `AgentSessionAttachmentExpiredError` for a gone one. */
export type AgentSessionAttachmentClaimer = (
  sessionId: string,
  body: AgentJournalMessageItem
) => Promise<void>

let installedStore: AgentSessionAttachmentStore | null = null
let installedClaimer: AgentSessionAttachmentClaimer | null = null

export function setAgentSessionAttachmentStore(
  store: AgentSessionAttachmentStore | null,
  claimer: AgentSessionAttachmentClaimer | null = null
): void {
  installedStore = store
  installedClaimer = store ? claimer : null
}

export function getAgentSessionAttachmentStore(): AgentSessionAttachmentStore | null {
  return installedStore
}

export function getAgentSessionAttachmentClaimer(): AgentSessionAttachmentClaimer | null {
  return installedClaimer
}

const uploadRemovalListeners = new Set<(uploadDir: string) => void>()

/** Notify removal attempts, including failures, so drafts recheck earlier preview availability. */
export function subscribeAgentSessionUploadRemoval(
  listener: (uploadDir: string) => void
): () => void {
  uploadRemovalListeners.add(listener)
  return () => uploadRemovalListeners.delete(listener)
}

export function publishAgentSessionUploadRemoval(uploadDir: string): void {
  uploadRemovalListeners.forEach((listener) => listener(uploadDir))
}
