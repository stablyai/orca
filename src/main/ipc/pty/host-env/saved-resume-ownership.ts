import type {
  AgentStatusIpcPayload,
  RefusedPaneResume
} from '../../../../shared/agent-status/contracts/agent-status-ipc-payload'
import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-resume'
import { agentProviderSessionsEqual } from '../../../../shared/agent-session/lifecycle/resume/agent-provider-session-equality'
import type { AgentSessionRecordStore } from '../../../runtime/agent-session/records/agent-session-record-store'
import {
  agentSessionLeasePossiblyWriting,
  listStructuredProviderSessionOwnership
} from '../../../native-chat/agent-session-wire/host/structured-provider-session-ownership'
import {
  keysMayMatch,
  terminalConversationKey
} from '../../../native-chat/conversation-adoption/structured-conversation-key'

/** `chat-home`: an automatic restore of a conversation an open chat continues; `chat-writing`:
 *  any start of one a chat may be writing; `unverifiable`: an automatic restore with no records,
 *  or another live terminal holding the conversation. */
export type ResumeSpawnRefusal = {
  sourceRecord?: SleepingAgentSessionRecord
  verdict: 'chat-home' | 'chat-writing' | 'unverifiable'
  refused: RefusedPaneResume
}

export type ResumeSpawnAdmission =
  | { verdict: 'admitted'; refused: RefusedPaneResume; sourceRecord?: SleepingAgentSessionRecord }
  | ResumeSpawnRefusal

export type AdmissionRuntime = {
  getAgentProviderSessionRows?(): AgentStatusIpcPayload[]
  isTerminalProviderSessionHeld?(
    row: AgentStatusIpcPayload,
    connectionId: string | null,
    wslDistro: string | null,
    restoringPtyId?: string
  ): Promise<boolean>
  readSavedResumeSource?(
    worktreeId: string,
    paneKey: string
  ): Promise<SleepingAgentSessionRecord | undefined>
  openAgentSessionRecordStore(): Promise<AgentSessionRecordStore>
}

export async function judgeSavedResume(
  runtime: AdmissionRuntime | undefined,
  refused: RefusedPaneResume,
  connectionId: string | null,
  wslDistro: string | null,
  options: { restoringPtyId?: string; spawnIntent?: unknown } = {}
): Promise<ResumeSpawnAdmission | null> {
  if (runtime && options.spawnIntent !== 'user-resume') {
    for (const row of runtime.getAgentProviderSessionRows?.() ?? []) {
      if (
        terminalResumeRowMatches(row, refused.agent, refused.providerSession) &&
        (await runtime.isTerminalProviderSessionHeld?.(
          row,
          connectionId,
          wslDistro,
          options.restoringPtyId
        ))
      ) {
        // Keep the recipe until this temporary owner exits, using the existing cross-version refusal.
        return { verdict: 'unverifiable', refused }
      }
    }
  }
  // Native chats cannot own conversations on SSH hosts or in WSL distributions.
  if (connectionId || wslDistro !== null) {
    return null
  }
  return runtime ? judgeResumes(runtime, [refused]) : { verdict: 'unverifiable', refused }
}

export function terminalResumeRowMatches(
  row: AgentStatusIpcPayload,
  agent: AgentStatusIpcPayload['agentType'],
  providerSession: AgentStatusIpcPayload['providerSession']
): boolean {
  return (
    !row.structuredHost &&
    row.agentType === agent &&
    agentProviderSessionsEqual(agent, row.providerSession, providerSession)
  )
}

async function judgeResumes(
  runtime: AdmissionRuntime,
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
  const heads = listStructuredProviderSessionOwnership(store.listConversations()).filter(
    (holding) => holding.role === 'head'
  )
  const tabs = store.getVisibleSessionTabIndex()
  for (const refused of resumes) {
    const holders = heads.filter((holding) =>
      keysOf(refused).some((key) => keysMayMatch(holding.key, key))
    )
    if (holders.some((holding) => agentSessionLeasePossiblyWriting(holding.ownerObservation))) {
      return { verdict: 'chat-writing', refused }
    }
    if (holders.length > 0 && (!tabs || !tabs.present)) {
      return { verdict: 'unverifiable', refused }
    }
    if (tabs && holders.some((holding) => tabs.sessionIds.includes(holding.sessionId))) {
      return { verdict: 'chat-home', refused }
    }
  }
  return admitted()
}
