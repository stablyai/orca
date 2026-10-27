import { homedir } from 'node:os'
import { join } from 'node:path'
import { sessionIdFromFileName } from '../ai-vault/session-scanner-accumulator'
import { walkSessionFiles } from '../ai-vault/session-scanner-discovery'
import { piSessionHistorySessionsDir } from '../ai-vault/session-scanner-agent-sources'
import { directoryTranscriptImport } from '../native-chat/structured-agent-cli-conversations'
import { readPiSessionHeader } from './rpc-launch-resolution'

export const PI_TRANSCRIPT_IMPORT = directoryTranscriptImport({
  conversationStore: () => piSessionHistorySessionsDir(),
  // Session History's host source is authoritative, including when the chat chose another home.
  accountHomeCandidates: () => [
    process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), '.pi', 'agent')
  ],
  findTranscript: async ({ providerSessionId, store, strictErrors }) => {
    const files = await walkSessionFiles(store, 'pi', [], {
      extensions: new Set(['.jsonl']),
      strictErrors,
      filePredicate: (path) => sessionIdFromFileName(path) === providerSessionId
    })
    if (files.length !== 1) {
      return null
    }
    const file = files[0]
    if (!file) {
      return null
    }
    const header = await readPiSessionHeader(file)
    if (header?.id !== providerSessionId) {
      return null
    }
    return file
  },
  handleNamesTranscript: true
})
