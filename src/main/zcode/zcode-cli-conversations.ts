// How a ZCode chat adopts its CLI's recorded conversation, and how it owns the Session History
// rows that conversation is listed under.

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  directoryTranscriptImport,
  resumeInvocationFromOptions,
  type StructuredAgentCliConversations,
  type StructuredAgentSessionHistory
} from '../native-chat/structured-agent-cli-conversations'

const ZCODE_TRANSCRIPT_IMPORT = directoryTranscriptImport({
  // One store per account home: the launch already pinned where the chat runs.
  conversationStore: ({ accountHomePath }) => join(accountHomePath, 'cli', 'db', 'db.sqlite'),
  accountHomeCandidates: ({ selectedAccountHomePath }) => [selectedAccountHomePath],
  // ZCode's conversation lives in its own SQLite store, which the adapter reads back through
  // `session/resume`, so the database's presence is the adoption proof.
  findTranscript: async ({ store }) => (existsSync(store) ? store : null)
})

const ZCODE_SESSION_HISTORY: StructuredAgentSessionHistory = {
  rowAgents: ['zcode'],
  rowSessionId: (link) => link.handle.nativeId,
  // `--resume <id>` names the conversation; `-c/--continue` lets the CLI pick one.
  parseResumeArgs: (args) =>
    resumeInvocationFromOptions(args, {
      targetless: ['-c', '--continue'],
      markers: ['--resume']
    })
}

export const ZCODE_CLI_CONVERSATIONS: StructuredAgentCliConversations = {
  transcriptImport: ZCODE_TRANSCRIPT_IMPORT,
  sessionHistory: ZCODE_SESSION_HISTORY
}
