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
