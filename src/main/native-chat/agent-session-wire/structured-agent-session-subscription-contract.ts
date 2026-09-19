import type { AgentSessionExecutionView } from '../../../shared/agent-session-execution-view'
import type { AgentJournalCursor } from '../../../shared/agent-session-journal-types'
import type {
  AgentSessionSlashCommand,
  AgentSessionSubscribeEvent
} from '../../../shared/agent-session-wire'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'

export type AgentSessionSubscriberEmit = (event: AgentSessionSubscribeEvent) => void
export type AgentSessionSubscribeInput = {
  id: string
  sessionId: string
  emit: AgentSessionSubscriberEmit
  cursor?: AgentJournalCursor
}

export type Subscriber = {
  id: string
  sessionId: string
  emit: AgentSessionSubscriberEmit
  cursor: AgentJournalCursor
  fence: number
  commands?: AgentSessionSlashCommand[] | null
  executionRevision?: number
}

export type AgentSessionSubscribersHooks = {
  readExecution?: (sessionId: string) => AgentSessionExecutionView | undefined
  readCommands?: (sessionId: string) => AgentSessionSlashCommand[] | undefined
  /** Fires after any publication that can change journal content, whether or not anyone
   *  is subscribed to the transcript: session lists project status from this same edge. */
  onJournalPublished?: (sessionId: string, journal: AgentSessionJournal) => void
  /** Host wall clock, stamped once per published frame as `hostNow`. */
  now?: () => number
}
