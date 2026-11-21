import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { agentSessionAccountHomePath } from '../../../shared/agent-session/lifecycle/accounts/agent-session-account-home'
import {
  absoluteConversationStore,
  type StructuredAgentTranscriptImport
} from '../../native-chat/conversation-adoption/structured-agent-cli-conversations'

// zcode keeps conversations in its own SQLite store, not transcript files — a container store,
// like opencode's. Fork admission only requires the store to resolve; adoption additionally
// proves the session row exists by parsing it through the ai-vault reader worker (never
// synchronous SQLite on the main thread).

function zcodeCliStore(launchEnv: NodeJS.ProcessEnv): string | null {
  const home =
    launchEnv.ZCODE_HOME?.trim() ||
    join(
      process.platform === 'win32' ? launchEnv.USERPROFILE?.trim() || homedir() : homedir(),
      '.zcode'
    )
  return absoluteConversationStore(join(home, 'cli', 'db', 'db.sqlite'))
}

export const ZCODE_TRANSCRIPT_IMPORT: StructuredAgentTranscriptImport = {
  readableContext: { kind: 'container' },
  // The pinned account home outranks ambient ZCODE_HOME: fork/adoption lookups must read the
  // account the record belongs to, never an env-selected other one.
  conversationStore: ({ accountHome, launchEnv }) => {
    const home = agentSessionAccountHomePath(accountHome)
    return zcodeCliStore(home ? { ...launchEnv, ZCODE_HOME: home } : launchEnv)
  },
  accountHomeCandidates: ({ selectedAccountHome }) => [selectedAccountHome],
  admitTranscriptPath: async ({ store: dbPath, transcriptPath }) =>
    transcriptPath === dbPath ? dbPath : null,
  findTranscript: async ({ providerSessionId, store: dbPath }) => {
    try {
      if (!(await stat(dbPath)).isFile()) {
        return null
      }
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        (error.code === 'ENOENT' || error.code === 'ENOTDIR')
      ) {
        return null
      }
      throw error
    }
    const { parseZcodeSqliteSessionViaWorker } =
      await import('../../ai-vault/scanners/opencode/reader-transport/session-scanner-opencode-sqlite-worker-spawn')
    const session = await parseZcodeSqliteSessionViaWorker({
      dbPath,
      sessionId: providerSessionId,
      platform: process.platform
    })
    return session ? dbPath : null
  }
}
