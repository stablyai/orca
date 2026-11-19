import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { isLegacyAgentSessionAccountHome } from '../../shared/agent-session/lifecycle/accounts/agent-session-account-home'
import {
  absoluteConversationStore,
  type StructuredAgentTranscriptImport
} from '../native-chat/conversation-adoption/structured-agent-cli-conversations'
import { admitTranscriptPath } from '../native-chat/transcript-discovery/transcript-path-admission'
import { antigravityHostAccountHome, isAntigravityHostAccountHome } from './antigravity-host-acp'

/** agy keeps terminal conversations here; the host's `agy acp` reads and writes the same store. */
const AGY_CONVERSATION_FOLDER = 'antigravity-cli'
// The full transcript keeps every step; agy may compact the other.
const TRANSCRIPT_FILES = ['transcript_full.jsonl', 'transcript.jsonl'] as const
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

// Only the host's own agy can open a terminal conversation: Orca's managed Antigravity server keeps
// a separate home, so an adopted chat pins agy's account home, which runs the host's `agy acp`.
// When that agy is missing, too old or signed out, the chat's start says so like any host chat.
export const ANTIGRAVITY_TRANSCRIPT_IMPORT: StructuredAgentTranscriptImport = {
  readableContext: { kind: 'file' },
  conversationStore: ({ accountHome }) =>
    isLegacyAgentSessionAccountHome(accountHome) && isAntigravityHostAccountHome(accountHome)
      ? absoluteConversationStore(join(accountHome.path, AGY_CONVERSATION_FOLDER))
      : null,
  admitTranscriptPath: async ({ store, transcriptPath }) =>
    (await admitTranscriptPath(store, transcriptPath))?.path ?? null,
  accountHomeCandidates: ({ selectedAccountHome }) => [
    isAntigravityHostAccountHome(selectedAccountHome)
      ? selectedAccountHome
      : antigravityHostAccountHome(homedir())
  ],
  findTranscript: async ({ providerSessionId, store }) => {
    if (!CONVERSATION_ID.test(providerSessionId)) {
      return null
    }
    const logs = join(store, 'brain', providerSessionId, '.system_generated', 'logs')
    for (const name of TRANSCRIPT_FILES) {
      const path = join(logs, name)
      if (await isFile(path)) {
        return path
      }
    }
    return null
  }
}
