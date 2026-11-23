// The work record's shapes: what it reads from orchestration and workspaces.
import type { AgentJournalMessageItem } from '../../shared/agent-session/journal/agent-session-journal-types'
import type { OrchestrationSessionWorkerState } from '../../shared/orchestration-session-workers'
import type { BotWorkPullRequest } from '../../shared/bots/bot-work-pull-request'
import type { BotWorkAddress, BotWorkHost, BotWorkRow, BotWorkStore } from './bot-work-store'

/** A row's worker as orchestration reads it now, at the newest Dispatch of its lineage. */
export type BotWorkWorker = {
  dispatchId: string
  taskId: string
  title: string
  agent: string | null
  state: OrchestrationSessionWorkerState
  /** Its Dispatch is open but its agent waits, on its coordinator or an answer. */
  idle?: boolean
  /** Its durable record says it was stopped or abandoned. */
  stopped: boolean
  /** Its start failed before any agent ran, as a lost or unknown start can turn out. */
  startFailed: boolean
  host: BotWorkHost
  /** The paired server's name, for a remote worker. */
  hostName: string | null
  worktreeId: string | null
  startedAt: number
  /** When it last finished; null while it runs or when unread. */
  settledAt: number | null
}

export type BotWorkWorkspace = {
  name: string
  /** Null on a detached HEAD. */
  branch: string | null
  head: string
  /** Its PR as the workspace's row shows it (the desktop's cached read); null when it shows none. */
  pullRequest: BotWorkPullRequest | null
}

/** A conversation turn of a bot: whose, and where it came from. */
export type BotTurnAddress = {
  botId: string
  address: BotWorkAddress
  /** The turn was asked in Orca, not through the conversation's connector. */
  askedInApp?: boolean
}

export type BotWorkRecordDeps = {
  store: () => BotWorkStore
  /** Each Dispatch's worker, read in one batch; null when orchestration has no such Task or
   *  Dispatch, left out when that one can't be read. Throws when orchestration can't be read. */
  workers: (dispatchIds: readonly string[]) => Promise<ReadonlyMap<string, BotWorkWorker | null>>
  /** A workspace reader for one batch of rows, sharing its repo reads. Each read is 'gone' only with
   *  proof; null when it can't be told (an offline host, a remote server). */
  workspaces: () => (worker: BotWorkWorker) => Promise<BotWorkWorkspace | 'gone' | null>
  /** What the conversation is called, from the message that started it. */
  conversationTitle: (address: BotWorkAddress) => string | null
  /** The conversation the message a bot session's turn was handed names; null for the owner's
   *  own words. */
  turnAddress: (
    sessionId: string,
    message: Pick<AgentJournalMessageItem, 'origin'>
  ) => Promise<BotTurnAddress | null>
}

/** A live row as validated now: its worker, or null when that can't be read. */
export type BotWorkCheck = {
  row: BotWorkRow
  worker: BotWorkWorker | null
  workspace: BotWorkWorkspace | null
}
