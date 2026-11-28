// Electron-free: shared by the orchestration reader thread and its client.
import type { ConnectorWorkerCandidates } from '../connector-workers/connector-worker-candidates'
import type { BotGroupTurnDetailPage } from '../../../../../shared/bots/use-bot-group-turn-details'
import type { BotGroupMessage } from '../../../../../shared/bots/bot-group'

export type BotGroupTurnSourceInput = {
  groupId: string
  threadId?: string
  operationId: string
  messageId: string
  version: number
  before?: number
}

export type BotGroupTurnSource =
  | { kind: 'journal'; sessionId: string; turnItemId?: string }
  | { kind: 'frozen'; page: BotGroupTurnDetailPage }
  | null

/** Room post reads execute in the reader thread so paging never blocks the runtime loop. */
export type BotGroupPostReadInput =
  | { kind: 'page'; groupId: string; threadId?: string; limit: number; beforeSequence?: number }
  | { kind: 'post'; id: string }
  | { kind: 'operation'; operationId: string }

export type BotGroupPostReadResult =
  | { kind: 'page'; messages: BotGroupMessage[] }
  | { kind: 'post'; message: BotGroupMessage | null }

/** Each read the thread runs, by name, with its arguments and answer. */
export type OrchestrationReads = {
  connectorWorkerCandidates: {
    args: { sessionIds: readonly string[]; now: number }
    value: ConnectorWorkerCandidates
  }
  botGroupTurnSource: {
    args: BotGroupTurnSourceInput
    value: BotGroupTurnSource
  }
  botGroupPosts: {
    args: BotGroupPostReadInput
    value: BotGroupPostReadResult
  }
}

export type OrchestrationReadName = keyof OrchestrationReads

export type OrchestrationReaderRequest = {
  [K in OrchestrationReadName]: {
    id: number
    /** The orchestration database file; main opens and migrates it first. */
    path: string
    read: K
    args: OrchestrationReads[K]['args']
  }
}[OrchestrationReadName]

export type OrchestrationReaderResponse =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; error: string }
