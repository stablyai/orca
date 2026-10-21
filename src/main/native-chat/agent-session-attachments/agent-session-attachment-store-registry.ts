// The installed attachment store, apart from the store itself: the RPC methods are imported
// wherever the method table is, and must not load the store's file-reading dependencies with it.

import type { AgentSessionAttachmentStore } from './agent-session-attachment-store'

let installedStore: AgentSessionAttachmentStore | null = null

/** Installed with the structured host, which owns the state directory the store lives in. */
export function setAgentSessionAttachmentStore(store: AgentSessionAttachmentStore | null): void {
  installedStore = store
}

export function getAgentSessionAttachmentStore(): AgentSessionAttachmentStore | null {
  return installedStore
}

const uploadRemovalListeners = new Set<(uploadDir: string) => void>()

/** Told after each sweep removal attempt, so a draft that checked its image before can check
 *  again; an attempt, not proof: a removal can fail. */
export function subscribeAgentSessionUploadRemoval(
  listener: (uploadDir: string) => void
): () => void {
  uploadRemovalListeners.add(listener)
  return () => uploadRemovalListeners.delete(listener)
}

export function publishAgentSessionUploadRemoval(uploadDir: string): void {
  uploadRemovalListeners.forEach((listener) => listener(uploadDir))
}
