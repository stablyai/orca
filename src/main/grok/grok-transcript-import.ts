import { join } from 'node:path'
import { findGrokChatHistoryByCwd, resolveGrokHomeDir } from '../../shared/grok-session-paths'
import { resolveSessionFilePath } from '../native-chat/session-file-resolver'
import { directoryTranscriptImport } from '../native-chat/structured-agent-cli-conversations'

export const GROK_TRANSCRIPT_IMPORT = directoryTranscriptImport({
  conversationStore: ({ accountHomePath }) => join(accountHomePath, 'sessions'),
  // The chat's own home, then the one Session History lists Grok's conversations from.
  accountHomeCandidates: ({ selectedAccountHomePath }) => [
    selectedAccountHomePath,
    resolveGrokHomeDir()
  ],
  findTranscript: async ({ providerSessionId, store, workspaceCwd, strictErrors }) =>
    (await findGrokChatHistoryByCwd({ sessionId: providerSessionId, cwd: workspaceCwd, sessionsDir: store })) ??
    resolveSessionFilePath('grok', providerSessionId, { grokSessionsDir: store, strictErrors })
})
