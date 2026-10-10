import { homedir } from 'node:os'
import { OPENCODE_TRANSCRIPT_MAX_WINDOW } from '../../shared/opencode-transcript-page-limit'
import type { AcpStoredUserMessagesReader } from '../acp/acp-recovery-history'
import { resolveOpenCodeDatabasePath } from './opencode-data-directory'
import type { readOpenCodeTranscriptPageViaWorker } from '../ai-vault/session-scanner-opencode-sqlite-worker-spawn'

export type OpenCodeTranscriptPageReader = typeof readOpenCodeTranscriptPageViaWorker

/** The latest user messages of an OpenCode session, read from the database its pinned account
 *  selects, through the existing bounded reader: 2.x's `session_v2` rows first, else 1.x's. */
export function openCodeStoredUserMessagesReader(
  readPage?: OpenCodeTranscriptPageReader
): AcpStoredUserMessagesReader {
  return async ({ env, providerSessionId, signal }) => {
    // The child's own home, which its account may name, not this process's.
    const home = (process.platform === 'win32' ? env.USERPROFILE : env.HOME) || homedir()
    const dbPath = resolveOpenCodeDatabasePath(env, home)
    if (!dbPath) {
      return null
    }
    const read =
      readPage ??
      (await import('../ai-vault/session-scanner-opencode-sqlite-worker-spawn'))
        .readOpenCodeTranscriptPageViaWorker
    const page = await read(
      { dbPath, sessionId: providerSessionId, limit: OPENCODE_TRANSCRIPT_MAX_WINDOW },
      signal
    )
    if (!page) {
      return null
    }
    return page.items.flatMap(({ message }) =>
      message.role === 'user' && message.timestamp !== null
        ? [{ id: message.id, blocks: message.blocks, createdAt: message.timestamp }]
        : []
    )
  }
}
