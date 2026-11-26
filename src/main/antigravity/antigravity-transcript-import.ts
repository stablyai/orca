import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import {
  directoryTranscriptImport,
  type StructuredAgentTranscriptImport
} from '../native-chat/conversation-adoption/structured-agent-cli-conversations'
import { agentSessionRefusalError } from '../../shared/agent-session/failures/agent-session-wire-refusals'
import { agentSessionAccountHomePath } from '../../shared/agent-session/lifecycle/accounts/agent-session-account-home'
import { agyUsesApiKey, isAntigravityHostAccountHome } from './antigravity-host-acp'

/** agy keeps terminal conversations here; the host's `agy acp` reads and writes the same store. */
const AGY_CONVERSATION_FOLDER = 'antigravity-cli'
// agy may compact transcript.jsonl; the full transcript keeps every step.
const FULL_TRANSCRIPT = 'transcript_full.jsonl'
const COMPACT_TRANSCRIPT = 'transcript.jsonl'
const CONVERSATION_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      (error.code === 'ENOENT' || error.code === 'ENOTDIR')
    ) {
      return false
    }
    throw error
  }
}

function isAgyHome(path: string): boolean {
  return isAntigravityHostAccountHome({ variable: 'GEMINI_HOME', path })
}

const directories = directoryTranscriptImport({
  // Orca's managed Antigravity server keeps a separate home that never holds these conversations.
  conversationStore: ({ accountHomePath }) =>
    isAgyHome(accountHomePath) ? join(accountHomePath, AGY_CONVERSATION_FOLDER) : null,
  // Only the host's own agy can open them, so an adopted chat pins agy's home and runs `agy acp`;
  // a missing, outdated or signed-out agy then fails the chat's start like any host chat.
  // HOME (Git Bash, MSYS) can differ from the USERPROFILE home agy itself uses on Windows.
  accountHomeCandidates: ({ selectedAccountHomePath }) => [
    ...new Set([
      ...(isAgyHome(selectedAccountHomePath) ? [selectedAccountHomePath] : []),
      join(homedir(), '.gemini')
    ])
  ],
  findTranscript: async ({ providerSessionId, store }) => {
    if (!CONVERSATION_ID.test(providerSessionId)) {
      return null
    }
    const logs = join(store, 'brain', providerSessionId, '.system_generated', 'logs')
    for (const name of [FULL_TRANSCRIPT, COMPACT_TRANSCRIPT]) {
      if (await isFile(join(logs, name))) {
        return join(logs, name)
      }
    }
    return null
  }
})

export const ANTIGRAVITY_TRANSCRIPT_IMPORT: StructuredAgentTranscriptImport = {
  ...directories,
  // A host chat drops inherited API keys, so an agy set up for one would fail every prompt.
  accountHomeCandidates: async (input) => {
    const homes = await directories.accountHomeCandidates(input)
    const usable = await Promise.all(
      homes.map(
        async (home) => !(await agyUsesApiKey(dirname(agentSessionAccountHomePath(home) ?? '')))
      )
    )
    const candidates = homes.filter((_, index) => usable[index])
    if (homes.length > 0 && candidates.length === 0) {
      throw agentSessionRefusalError(
        'structured_agent_session_unsupported',
        { reason: 'hostUnsupported' },
        'agy is set up with an API key, which Antigravity Chat cannot use. Continue this conversation in the terminal.'
      )
    }
    return candidates
  },
  // A hook may name the compact transcript; import the full one beside it when it exists.
  admitTranscriptPath: async (input) => {
    const admitted = await directories.admitTranscriptPath(input)
    if (!admitted || basename(admitted) !== COMPACT_TRANSCRIPT) {
      return admitted
    }
    const full = join(dirname(admitted), FULL_TRANSCRIPT)
    // An unreadable full transcript leaves the admitted compact one.
    return (await isFile(full).catch(() => false))
      ? ((await directories.admitTranscriptPath({ store: input.store, transcriptPath: full })) ??
          admitted)
      : admitted
  }
}
