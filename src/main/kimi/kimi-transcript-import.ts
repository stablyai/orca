import { readdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { directoryTranscriptImport } from '../native-chat/conversation-adoption/structured-agent-cli-conversations'
import { isTranscriptFile } from '../native-chat/transcript-discovery/transcript-file-presence'
import { readJsonObjectIfExists } from '../ai-vault/discovery/session-json-file'
import { kimiPrimaryAgentWirePath } from '../ai-vault/scanners/kimi/session-scanner-kimi-paths'

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

/** The start Kimi gives a workspace folder's name (`wd_<slug>_<path hash>`); the hash depends on
 *  how the path is spelled, so only the slug is matched. */
function workspaceFolderPrefix(workspaceCwd: string): string {
  const name = basename(workspaceCwd.replace(/[\\/]+$/, '')).toLowerCase()
  const slug = name
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/^-+|-+$/g, '')
  return `wd_${slug}_`
}

/** Kimi saves each session under `sessions/<workspace folder>/<session id>`; chats and terminals
 *  share it, and the primary agent's `wire.jsonl` holds the conversation. */
export const KIMI_TRANSCRIPT_IMPORT = directoryTranscriptImport({
  conversationStore: ({ accountHomePath }) => join(accountHomePath, 'sessions'),
  accountHomeCandidates: ({ selectedAccountHomePath }) => [selectedAccountHomePath],
  findTranscript: async ({ providerSessionId, store, workspaceCwd }) => {
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
    // The workspace's own folders first; a session saved in a sub-folder is still found by the scan.
    const prefix = workspaceFolderPrefix(workspaceCwd)
    const rank = (name: string): number => (name.startsWith(prefix) ? 0 : 1)
    folders.sort((a, b) => rank(a.name) - rank(b.name))
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
