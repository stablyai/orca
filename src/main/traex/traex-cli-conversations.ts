import { basename, join } from 'node:path'
import { walkSessionFiles } from '../ai-vault/discovery/session-scanner-discovery'
import { wslGatedStat } from '../native-chat/transcript-filesystem/wsl-transcript-fs-access'
import {
  directoryTranscriptImport,
  resumeInvocationAfterMarker,
  resumeInvocationFromOptions,
  type StructuredAgentCliConversations
} from '../native-chat/conversation-adoption/structured-agent-cli-conversations'
import { traexPrivateHome } from './traex-launch-resolution'

export const TRAEX_CLI_CONVERSATIONS: StructuredAgentCliConversations = {
  transcriptImport: directoryTranscriptImport({
    conversationStore: ({ accountHomePath }) => join(accountHomePath, 'sessions'),
    accountHomeCandidates: ({ selectedAccountHomePath }) => [
      selectedAccountHomePath,
      traexPrivateHome(process.env)
    ],
    findTranscript: async ({ providerSessionId, store, strictErrors }) => {
      // Paginated history names the conversation before its segment id, so match anywhere.
      const files = await walkSessionFiles(store, 'trae', [], {
        extensions: new Set(['.jsonl']),
        strictErrors,
        filePredicate: (path) => basename(path).includes(providerSessionId)
      })
      let newest: string | null = null
      let newestAt = Number.NEGATIVE_INFINITY
      for (const path of files) {
        try {
          const { mtimeMs } = await wslGatedStat(path, 'scan')
          if (mtimeMs > newestAt) {
            newest = path
            newestAt = mtimeMs
          }
        } catch {
          newest ??= path
        }
      }
      return newest
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
