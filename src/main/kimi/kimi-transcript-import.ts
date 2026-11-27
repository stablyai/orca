import { createHash } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { directoryTranscriptImport } from '../native-chat/conversation-adoption/structured-agent-cli-conversations'
import { isTranscriptFile } from '../native-chat/transcript-discovery/transcript-file-presence'
import { readJsonObjectIfExists } from '../ai-vault/discovery/session-json-file'
import {
  kimiPrimaryAgentWirePath,
  readKimiWorkDirBySessionId
} from '../ai-vault/scanners/kimi/session-scanner-kimi-paths'

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

/** Kimi's name for the folder holding a work directory's sessions: `wd_<slug>_<path hash>`. */
function kimiWorkspaceFolder(workDir: string): { name: string; prefix: string } {
  const normalized = workDir.replaceAll('\\', '/').replace(/\/+$/, '')
  const trimmed = (value: string) => value.replace(/^-+|-+$/g, '')
  const slug = trimmed(
    trimmed(
      (normalized.split('/').pop() ?? normalized).toLowerCase().replace(/[^a-z0-9._-]+/g, '-')
    ).slice(0, 40)
  )
  const prefix = `wd_${slug === '' || slug === '.' || slug === '..' ? 'workspace' : slug}_`
  return {
    name: prefix + createHash('sha256').update(normalized).digest('hex').slice(0, 12),
    prefix
  }
}

/** Kimi saves each session under `sessions/<workspace folder>/<session id>`; chats and terminals
 *  share it, and the primary agent's `wire.jsonl` holds the conversation. */
export const KIMI_TRANSCRIPT_IMPORT = directoryTranscriptImport({
  conversationStore: ({ accountHomePath }) => join(accountHomePath, 'sessions'),
  accountHomeCandidates: ({ selectedAccountHomePath }) => [selectedAccountHomePath],
  // Kimi's session index names the folder each session ran in, which names its workspace folder.
  findTranscript: async ({ providerSessionId, store }) => {
    if (!SESSION_ID.test(providerSessionId)) {
      return null
    }
    const workDirs = await readKimiWorkDirBySessionId(join(dirname(store), 'session_index.jsonl'))
    const workDir = workDirs.get(providerSessionId)
    if (!workDir) {
      return null
    }
    const wireIn = async (folder: string): Promise<string | null | undefined> => {
      const statePath = join(store, folder, providerSessionId, 'state.json')
      if (!(await isTranscriptFile(statePath))) {
        return undefined
      }
      const wire = kimiPrimaryAgentWirePath(statePath, await readJsonObjectIfExists(statePath))
      return (await isTranscriptFile(wire)) ? wire : null
    }
    const own = kimiWorkspaceFolder(workDir)
    const found = await wireIn(own.name)
    if (found !== undefined) {
      return found
    }
    // A Kimi release that hashes the path differently still keeps the folder's name.
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
      if (folder.isDirectory() && folder.name !== own.name && folder.name.startsWith(own.prefix)) {
        const other = await wireIn(folder.name)
        if (other !== undefined) {
          return other
        }
      }
    }
    return null
  }
})
