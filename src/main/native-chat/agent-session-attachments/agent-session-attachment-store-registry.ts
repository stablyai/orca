// Keep RPC method imports from eagerly loading attachment-store filesystem dependencies.

import type { AgentSessionAttachmentStore } from './agent-session-attachment-store'

let installedStore: AgentSessionAttachmentStore | null = null

export function setAgentSessionAttachmentStore(store: AgentSessionAttachmentStore | null): void {
  installedStore = store
}

export function getAgentSessionAttachmentStore(): AgentSessionAttachmentStore | null {
  return installedStore
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
