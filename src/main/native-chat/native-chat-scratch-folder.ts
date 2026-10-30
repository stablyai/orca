// Store scratch files beside the host’s chat journal, outside the user’s workspace.

import { createHash } from 'node:crypto'
import { join } from 'node:path'

const NATIVE_CHAT_SCRATCH_DIR_NAME = 'chat-scratch'
const FOLDER_NAME = /^[0-9a-f]{32}$/

export function nativeChatScratchRootFor(stateDirectory: string): string {
  return join(stateDirectory, NATIVE_CHAT_SCRATCH_DIR_NAME)
}

/** Hash arbitrary session IDs into one safe path segment. */
export function nativeChatScratchFolderName(sessionId: string): string {
  return createHash('sha256').update(sessionId, 'utf8').digest('hex').slice(0, 32)
}

export function isNativeChatScratchFolderName(name: string): boolean {
  return FOLDER_NAME.test(name)
}

/** Session-only identity permits lookup/removal without a workspace record. */
export function nativeChatScratchFolderFor(stateDirectory: string, sessionId: string): string {
  return join(nativeChatScratchRootFor(stateDirectory), nativeChatScratchFolderName(sessionId))
}
