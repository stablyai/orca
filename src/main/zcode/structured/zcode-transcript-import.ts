import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  absoluteConversationStore,
  type StructuredAgentTranscriptImport
} from '../../native-chat/conversation-adoption/structured-agent-cli-conversations'

// zcode keeps conversations in its own SQLite store, not transcript files — a container store,
// like opencode's. Fork admission only requires the store to resolve; inherited rows replay from
// the fork snapshot, and session-history adoption stays unwired for zcode, so the lookup stops at
// store existence rather than parsing rows.

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
  conversationStore: ({ launchEnv }) => zcodeCliStore(launchEnv),
  accountHomeCandidates: ({ selectedAccountHome }) => [selectedAccountHome],
  admitTranscriptPath: async ({ store: dbPath, transcriptPath }) =>
    transcriptPath === dbPath ? dbPath : null,
  findTranscript: async ({ store: dbPath }) => {
    try {
      return (await stat(dbPath)).isFile() ? dbPath : null
    } catch {
      return null
    }
  }
}
