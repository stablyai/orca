import type { RefusedPaneResume } from '../../../../shared/agent-status/contracts/agent-status-ipc-payload'
import type { AgentSessionRecordStore } from '../../../runtime/agent-session/records/agent-session-record-store'
import type { ResumeSpawnAdmission } from './saved-resume-admission'
import {
  agentSessionLeasePossiblyWriting,
  listStructuredProviderSessionOwnership
} from '../../../native-chat/agent-session-wire/host/structured-provider-session-ownership'
import {
  keysMayMatch,
  terminalConversationKey
} from '../../../native-chat/conversation-adoption/structured-conversation-key'

export async function judgeResumes(
  runtime: { openAgentSessionRecordStore(): Promise<AgentSessionRecordStore> },
  resumes: readonly [RefusedPaneResume, ...RefusedPaneResume[]]
): Promise<ResumeSpawnAdmission> {
  const keysOf = ({ agent, providerSession }: RefusedPaneResume) =>
    [providerSession.id, providerSession.transcriptPath].flatMap((id) =>
      id?.trim() ? [terminalConversationKey(agent, id)] : []
    )
  const admitted = (): ResumeSpawnAdmission => ({
    verdict: 'admitted',
    refused: resumes[0]
  })
  let store: AgentSessionRecordStore
  try {
    store = await runtime.openAgentSessionRecordStore()
  } catch (error) {
    console.warn(
      "[pty] native chat records unreadable; cannot tell whether a resume is a chat's",
      error
    )
    return { verdict: 'unverifiable', refused: resumes[0] }
  }
  const chatHomes = listStructuredProviderSessionOwnership(store.listConversations()).filter(
    (holding) => holding.role === 'head' || holding.retainedForSwitch
  )
  const tabs = store.getVisibleSessionTabIndex()
  for (const refused of resumes) {
    const keys = keysOf(refused)
    const holders = chatHomes.filter((holding) =>
      keys.some((key) => keysMayMatch(holding.key, key))
    )
    if (
      holders.some(
        (holding) =>
          holding.role === 'head' && agentSessionLeasePossiblyWriting(holding.ownerObservation)
      )
    ) {
      return { verdict: 'chat-writing', refused }
    }
    if (holders.length > 0 && (!tabs || !tabs.present)) {
      return { verdict: 'unverifiable', refused }
    }
    if (
      tabs &&
      holders.some(
        (holding) => holding.retainedForSwitch || tabs.sessionIds.includes(holding.sessionId)
      )
    ) {
      return { verdict: 'chat-home', refused }
    }
  }
  return admitted()
}
