// Where a structured chat's visuals live on the host that owns the chat: Orca-owned state beside the
// chat journal, never inside the user's workspace.

import { createHash } from 'node:crypto'
import { join } from 'node:path'

const NATIVE_CHAT_VISUALS_DIR_NAME = 'native-chat-visuals'

/**
 * `<stateDirectory>/native-chat-visuals/<sha256(session id), first 32 hex>`. Keyed by the session id
 * alone, the chat record's primary key, so the folder needs no workspace lookup to find or remove;
 * hashed so any id is one safe path segment.
 */
export function nativeChatVisualsFolderFor(stateDirectory: string, sessionId: string): string {
  const segment = createHash('sha256').update(sessionId, 'utf8').digest('hex').slice(0, 32)
  return join(stateDirectory, NATIVE_CHAT_VISUALS_DIR_NAME, segment)
}
