// Where a structured chat's scratch files (its inline visuals among them) live on the host that
// owns the chat: Orca-owned state beside the chat journal, never inside the user's workspace.

import { createHash } from 'node:crypto'
import { join } from 'node:path'

const NATIVE_CHAT_SCRATCH_DIR_NAME = 'chat-scratch'
const FOLDER_NAME = /^[0-9a-f]{32}$/

/** Where every chat's scratch folder on this host lives. */
export function nativeChatScratchRootFor(stateDirectory: string): string {
  return join(stateDirectory, NATIVE_CHAT_SCRATCH_DIR_NAME)
}

/** The one path segment a chat's folder is named by: hashed so any id is a safe segment. */
export function nativeChatScratchFolderName(sessionId: string): string {
  return createHash('sha256').update(sessionId, 'utf8').digest('hex').slice(0, 32)
}

/** A name this host minted for a chat's folder; nothing else under the root is a chat's. */
export function isNativeChatScratchFolderName(name: string): boolean {
  return FOLDER_NAME.test(name)
}

/**
 * `<stateDirectory>/chat-scratch/<sha256(session id), first 32 hex>`. Keyed by the session id
 * alone, the chat record's primary key, so the folder needs no workspace lookup to find or remove;
 * hashed so any id is one safe path segment.
 */
export function nativeChatScratchFolderFor(stateDirectory: string, sessionId: string): string {
  return join(nativeChatScratchRootFor(stateDirectory), nativeChatScratchFolderName(sessionId))
}
