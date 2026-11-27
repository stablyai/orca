import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { directoryTranscriptImport } from '../native-chat/conversation-adoption/structured-agent-cli-conversations'
import { isTranscriptFile } from '../native-chat/transcript-discovery/transcript-file-presence'
import { readJsonObjectIfExists } from '../ai-vault/discovery/session-json-file'
import { kimiPrimaryAgentWirePath } from '../ai-vault/scanners/kimi/session-scanner-kimi-paths'

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

/** Kimi saves each session under `sessions/<workspace folder>/<session id>`; chats and terminals
 *  share it, and the primary agent's `wire.jsonl` holds the conversation. */
export const KIMI_TRANSCRIPT_IMPORT = directoryTranscriptImport({
  conversationStore: ({ accountHomePath }) => join(accountHomePath, 'sessions'),
  accountHomeCandidates: ({ selectedAccountHomePath }) => [selectedAccountHomePath],
  findTranscript: async ({ providerSessionId, store }) => {
    if (!SESSION_ID.test(providerSessionId)) {
      return null
    }
    let folders
    try {
      folders = await readdir(store, { withFileTypes: true })
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return null
      }
      throw error
    }
    for (const folder of folders) {
      const statePath = join(store, folder.name, providerSessionId, 'state.json')
      if (folder.isDirectory() && (await isTranscriptFile(statePath))) {
        const wire = kimiPrimaryAgentWirePath(statePath, await readJsonObjectIfExists(statePath))
        return (await isTranscriptFile(wire)) ? wire : null
      }
    }
    return null
  }
})
