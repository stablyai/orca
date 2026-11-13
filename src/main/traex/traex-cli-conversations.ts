import { join } from 'node:path'
import { sessionIdFromFileName } from '../ai-vault/session-scanner-accumulator'
import { walkSessionFiles } from '../ai-vault/session-scanner-discovery'
import {
  directoryTranscriptImport,
  resumeInvocationAfterMarker,
  resumeInvocationFromOptions,
  type StructuredAgentCliConversations
} from '../native-chat/structured-agent-cli-conversations'
import { traexPrivateHome } from './traex-launch-resolution'

export const TRAEX_CLI_CONVERSATIONS: StructuredAgentCliConversations = {
  transcriptImport: directoryTranscriptImport({
    conversationStore: ({ accountHomePath }) => join(accountHomePath, 'sessions'),
    accountHomeCandidates: ({ selectedAccountHomePath }) => [
      selectedAccountHomePath,
      traexPrivateHome(process.env)
    ],
    findTranscript: async ({ providerSessionId, store, strictErrors }) => {
      const files = await walkSessionFiles(store, 'trae', [], {
        extensions: new Set(['.jsonl']),
        strictErrors,
        filePredicate: (path) => sessionIdFromFileName(path) === providerSessionId
      })
      return files.length === 1 ? (files[0] ?? null) : null
    }
  }),
  sessionHistory: {
    rowAgents: ['trae'],
    rowSessionId: (link) => link.handle.nativeId,
    parseResumeArgs: (args) =>
      resumeInvocationAfterMarker(args, ['resume']) ??
      resumeInvocationFromOptions(args, { targetless: ['--last'], markers: ['--resume'] })
  }
}
