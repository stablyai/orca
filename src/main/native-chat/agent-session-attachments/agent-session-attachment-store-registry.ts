// Keep RPC method imports from eagerly loading attachment-store filesystem dependencies.

import type { AgentJournalMessageItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentSessionAttachmentStore } from './agent-session-attachment-store'

/** Requires every store upload `body` references and claims it for `sessionId`, through the journal
 *  writer that owns claims and sweeps; throws `AgentSessionAttachmentExpiredError` for a gone one.
 *  Resolves to the claims this call newly took for that chat, when the claimer reports them. */
export type AgentSessionAttachmentClaimer = (
  sessionId: string,
  body: AgentJournalMessageItem
) => Promise<void | AgentSessionAttachmentClaimed>

/** The claims one claim call newly took: these uploads, for one chat, at one moment. */
export type AgentSessionAttachmentClaimed = { uploadIds: readonly string[]; claimedAt: number }

/** Drops exactly the claims one claim call took, so the sweep treats those uploads as unclaimed
 *  again; a claim taken anew since (another moment) is left alone. */
export type AgentSessionAttachmentReleaser = (
  sessionId: string,
  claimed: AgentSessionAttachmentClaimed
) => Promise<void>

let installedStore: AgentSessionAttachmentStore | null = null
let installedClaimer: AgentSessionAttachmentClaimer | null = null
let installedReleaser: AgentSessionAttachmentReleaser | null = null

export function setAgentSessionAttachmentStore(
  store: AgentSessionAttachmentStore | null,
  claimer: AgentSessionAttachmentClaimer | null = null,
  releaser: AgentSessionAttachmentReleaser | null = null
): void {
  installedStore = store
  installedClaimer = store ? claimer : null
  installedReleaser = store ? releaser : null
}

export function getAgentSessionAttachmentReleaser(): AgentSessionAttachmentReleaser | null {
  return installedReleaser
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
