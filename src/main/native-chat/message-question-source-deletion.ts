import { existsSync } from 'node:fs'
import { resolveNativeChatTranscriptAgent } from '../../shared/native-chat-agent-support'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import { getProfileUserDataPath } from '../orca-profiles/profile-storage-paths'
import {
  openAgentSessionRecordStoreOnce,
  type AgentSessionRecordStoreLocation
} from '../runtime/agent-session-record-store-slot'
import { journalDatabasePath } from './agent-session-journal/journal-host-database'
import {
  createStructuredAgentSessionLogger,
  neverThrowingStructuredAgentSessionLogger
} from './agent-session-wire/structured-agent-session-logger'
import { messageQuestionsFor } from './message-question-repository'

/** Called only with the existing deletion owner's approved agent and resolved path. */
export async function deleteTranscriptQuestionSource(
  agent: string,
  filePath: string,
  location?: AgentSessionRecordStoreLocation
): Promise<void> {
  const canonicalAgent = resolveNativeChatTranscriptAgent(agent)
  if (!canonicalAgent) {
    return
  }
  const owner = location ?? {
    stateDirectory: getProfileUserDataPath(),
    hostId: LOCAL_EXECUTION_HOST_ID,
    logger: neverThrowingStructuredAgentSessionLogger(createStructuredAgentSessionLogger())
  }
  if (!existsSync(journalDatabasePath(owner.stateDirectory))) {
    return
  }
  const { journalDatabase } = await openAgentSessionRecordStoreOnce(owner)
  messageQuestionsFor(journalDatabase).deleteTranscriptSources(canonicalAgent, filePath)
}
