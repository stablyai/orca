import { createHash } from 'node:crypto'
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
function kimiWorkspaceFolder(workDir: string): string {
  const normalized = workDir.replaceAll('\\', '/').replace(/\/+$/, '')
  const trimmed = (value: string) => value.replace(/^-+|-+$/g, '')
  const slug = trimmed(
    trimmed(
      (normalized.split('/').pop() ?? normalized).toLowerCase().replace(/[^a-z0-9._-]+/g, '-')
    ).slice(0, 40)
  )
  const name = slug === '' || slug === '.' || slug === '..' ? 'workspace' : slug
  return `wd_${name}_${createHash('sha256').update(normalized).digest('hex').slice(0, 12)}`
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
    // Kimi's own resume maps the index's work directory to its folder the same way.
    const statePath = join(store, kimiWorkspaceFolder(workDir), providerSessionId, 'state.json')
    if (!(await isTranscriptFile(statePath))) {
      return null
    }
    const wire = kimiPrimaryAgentWirePath(statePath, await readJsonObjectIfExists(statePath))
    return (await isTranscriptFile(wire)) ? wire : null
  }
})
