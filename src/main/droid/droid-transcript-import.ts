import { readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { directoryTranscriptImport } from '../native-chat/conversation-adoption/structured-agent-cli-conversations'
import { isTranscriptFile } from '../native-chat/transcript-discovery/transcript-file-presence'

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/

/** Droid saves `<session id>.jsonl` under one folder per session cwd; chats and terminals share it. */
export const DROID_TRANSCRIPT_IMPORT = directoryTranscriptImport({
  conversationStore: ({ accountHomePath }) => join(accountHomePath, '.factory', 'sessions'),
  // The chat's own home, then the one Session History lists Droid's conversations from.
  accountHomeCandidates: ({ selectedAccountHomePath }) => [
    ...new Set([selectedAccountHomePath, homedir()])
  ],
  // Folder names encode a session's cwd, so the workspace's own folders are probed first; other
  // spellings (a linked workspace, Windows drives) are still found by name.
  findTranscript: async ({ providerSessionId, store, workspaceCwd }) => {
    if (!SESSION_ID.test(providerSessionId)) {
      return null
    }
    const file = `${providerSessionId}.jsonl`
    const encoded = workspaceCwd.replace(/[\\/:]/g, '-')
    // A shortcut only: an unusable name (too long for the file system) falls back to the scan.
    if (encoded && (await isTranscriptFile(join(store, encoded, file)).catch(() => false))) {
      return join(store, encoded, file)
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
    const rank = (name: string): number => (encoded && name.startsWith(`${encoded}-`) ? 0 : 1)
    folders.sort((a, b) => rank(a.name) - rank(b.name))
    for (const folder of folders) {
      const path = join(store, folder.name, file)
      if (folder.isDirectory() && folder.name !== encoded && (await isTranscriptFile(path))) {
        return path
      }
    }
    return null
  }
})
