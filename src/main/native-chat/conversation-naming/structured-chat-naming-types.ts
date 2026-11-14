import type { AgentSessionRecord } from '../../../shared/agent-session/lifecycle/agent-session-record'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { AgentSessionRecordStore } from '../../runtime/agent-session/records/agent-session-record-store'
import type { AgentGenerationFailureOutput } from '../../text-generation/failures/agent-failure-output'
import type { StructuredAgentSessionLogger } from '../agent-session-wire/host/structured-agent-session-logger'
import type { StructuredAgentSessionAdapter } from '../agent-session-wire/providers/structured-agent-session-adapter'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'

export type AutomaticChatTitle = {
  owner: ReturnType<NonNullable<StructuredAgentSessionAdapter['captureConversationTitleOwner']>>
  pending?: {
    ready: Promise<AutomaticChatTitle['owner']>
    ended: () => boolean
    recheck: () => void
    unavailable: (journal: AgentSessionJournal) => void
    dispose: () => void
  }
  retainOwnership?: (isCurrent: (record: AgentSessionRecord) => boolean) => void
}

/** null means unavailable/canceled: no failure to display or retry. */
export type StructuredChatNameGeneration =
  | { name: string; shouldApply?: (record?: AgentSessionRecord) => boolean }
  | { error: string; errorCode?: string; failureOutput?: AgentGenerationFailureOutput }
  | null

export type StructuredChatNamingDeps = {
  getStore: () => Pick<
    AgentSessionRecordStore,
    'getRecord' | 'compareAndSetConversationName' | 'setUserConversationName'
  > | null
  getSettings: () => Pick<GlobalSettings, 'nativeChatAutoName'>
  readFirstPrompt: (sessionId: string, hostStartedAt: number) => Promise<string>
  /** The current context's first prompt, for a name the user asked for again. */
  readJournalFirstPrompt: (sessionId: string) => Promise<string>
  now?: () => number
  workerTaskTitle: (record: AgentSessionRecord) => { title: string } | null
  captureAutomaticTitle?: (
    record: AgentSessionRecord,
    firstInputSubmissionKey?: string,
    applicable?: () => boolean
  ) => AutomaticChatTitle | undefined
  generate: (
    record: AgentSessionRecord,
    firstPrompt: string,
    shouldExecute?: () => boolean,
    automaticTitle?: AutomaticChatTitle
  ) => Promise<StructuredChatNameGeneration>
  onNamed: (workspaceId: string, sessionId: string) => void
  logger: StructuredAgentSessionLogger
  wait?: (ms: number) => Promise<void>
}
