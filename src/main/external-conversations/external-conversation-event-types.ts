import type { AgentTurnOutcome } from '../../shared/agent-status/lifecycle/agent-turn-outcome'
import type { ExternalConversationLink } from '../../shared/connectors/external-conversation-link'
import type {
  ConnectorActsFor,
  ConnectorFailure,
  ConnectorPrompt,
  ConnectorTurnFor,
  ConnectorTurnOrigin
} from '../../shared/connectors/connector-cloud-contract'
import type { ConnectorWorkLink } from '../../shared/connector-work-link-contract'
import type { SnapshotEntryTrace } from './external-conversation-snapshot-prompts'
import type { ActivityEvent } from './external-conversation-turn-activity'
import type { ConversationPane } from './external-conversation-types'

export type ConversationEvent =
  // actsFor: whom the linked chat acts for, once Orca recorded it.
  | (ConversationPane & {
      kind: 'linked'
      agent: ExternalConversationLink['agent']
      actsFor?: ConnectorActsFor
    })
  // The linked chat was deleted, so its thread is free.
  | (ConversationPane & { kind: 'unlinked' })
  // answered: the agent worked past this prompt, so someone answered it in Orca.
  | (ConversationPane & {
      kind: 'prompt'
      prompt: ConnectorPrompt
      answered?: true
      answeredWith?: string
    })
  // deliveryId: the delivery the turn answers, when exactly one started it.
  | (ConversationPane & {
      kind: 'turn-started'
      at: number
      deliveryId?: string
      switchedAgent?: string
    })
  | (ConversationPane & {
      kind: 'turn-ended'
      /** The ended turn's turn-started `at`; null when its start predates this watch. The cloud ends
       *  its open turn when that is no newer, so a restart's end can name this start as a fence. */
      turnId: number | null
      /** Host verdict; null means none was recorded. */
      stopReason: AgentTurnOutcome | null
      lastAssistantMessage?: string
      at: number
      /** Whether a connector delivery or someone in Orca asked for the turn. */
      origin?: ConnectorTurnOrigin
      /** Why a failed turn failed. */
      failure?: ConnectorFailure
      /** Pull requests the conversation's bot work opened. */
      links?: ConnectorWorkLink[]
      /** An Orca-typed turn whose owner's words posted to the Slack thread: its reply posts too. */
      mirror?: true
      /** Whom a turn no delivery started acts for, so its final post counts as them on Slack. */
      turnFor?: ConnectorTurnFor
      /** The thread's turn state only: its answer goes through the reply outbox. */
      stateOnly?: true
      /** Paused at a usage limit with a known reset: an automatic continue picks it up then. */
      resumes?: true
    })
  // Whether orchestration workers the chat started still run, told on each change.
  | (ConversationPane & { kind: 'workers'; running: boolean })
  // What a heard turn is doing now (the tool it is inside), a few seconds apart at most.
  | ActivityEvent

export type ConversationSnapshot = {
  kind: 'snapshot'
  conversations: (ConversationPane & {
    agent: ExternalConversationLink['agent']
    working: boolean
    switchedAgent?: string
    prompt: ConnectorPrompt | null
    /** The pane's latest turn, as its turn events name it; null before any. */
    turnId: number | null
    /** When the conversation last showed activity: its link, or its agent's latest status report. */
    activeAt: number
    /** Once the chat's workers were read. */
    workersRunning?: boolean
    /** Why the entry reads as it does, for the snapshot's trace only; never sent. */
    trace?: SnapshotEntryTrace
  })[]
}

export type ConversationWatchListener = (event: ConversationSnapshot | ConversationEvent) => void
