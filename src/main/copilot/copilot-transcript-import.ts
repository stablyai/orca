import { join } from 'node:path'
import { directoryTranscriptImport } from '../native-chat/conversation-adoption/structured-agent-cli-conversations'
import { copilotEventsPath } from './copilot-session-paths'

/** Copilot stores one events.jsonl per session inside the account's session-state directory. */
export const COPILOT_TRANSCRIPT_IMPORT = directoryTranscriptImport({
  conversationStore: ({ accountHomePath }) => join(accountHomePath, 'session-state'),
  accountHomeCandidates: ({ selectedAccountHomePath }) => [selectedAccountHomePath],
  findTranscript: async ({ providerSessionId, store }) =>
    copilotEventsPath(store, providerSessionId)
})
