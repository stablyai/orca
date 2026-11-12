import type {
  AgentJournalAcceptanceReceipt,
  AgentJournalItemBody,
  AgentJournalMessageItem,
  AgentJournalRenderItem,
  AgentJournalSubmission,
  AgentJournalTurnLifecycle
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalCursor } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type { AgentSessionContextUsage } from '../../../shared/agent-session/agent-session-context-usage'
import type { JournalItemLinkageVisitor } from './journal-store-contracts'
import type {
  JournalHistoryItem,
  JournalHistoryReadOptions,
  JournalHistoryPrompt
} from './journal-history-items'
import type { JournalReducerState } from './projection/journal-reducer'
import type { JournalItemEcho } from './projection/journal-item-echo'
import type { JournalThreadGoalSource } from './projection/journal-thread-goal-source'
import type { ClaudeJournalSnapshot } from '../../claude/subagents/claude-subagent-journaled-identities'
import type { JournalInputReader } from './journal-input-reads'
import type { HostUsageLimitCut } from '../agent-session-wire/recovery/structured-agent-session-usage-limit-chain'
import type { JournalStatusState } from './journal-status-state'
import type { NativeChatOrcaStopCut } from '../../../shared/native-chat/native-chat-orca-stop-cut'
import type { AgentJournalTurnScope } from '../../../shared/agent-session/journal/agent-session-journal-turn-scope'
import type {
  JournalStatusIndicatorRead,
  JournalStatusIndicators
} from './journal-status-indicators'
import type {
  JournalOutgrownChild,
  JournalOutgrownChildRead,
  JournalRestartProgress
} from './journal-lifecycle-reads'

/** Which items a visit decodes; a database serves only the named kinds, in sequence order. */
export type JournalItemFilter = {
  kinds: readonly AgentJournalItemBody['kind'][]
}

export type JournalNamedTurn = {
  scope: Extract<AgentJournalTurnScope, { kind: 'turn' }> | null
  removed: boolean
}

export type JournalMessageOptions = { ordinaryMessage: boolean; runningTurn: boolean }

export type JournalContinuationContext = {
  cursor: AgentJournalCursor
  items: readonly AgentJournalRenderItem[]
  submissions: readonly AgentJournalSubmission[]
}

/** Reads a chat answers from its database; scans are filtered so none decodes the whole chat. */
export type AgentSessionJournalReads = {
  statusIndicators(input: JournalStatusIndicatorRead): Promise<JournalStatusIndicators>
  statusState(currentFence?: number | null): Promise<JournalStatusState>
  input: JournalInputReader
  usageLimitCut(): Promise<HostUsageLimitCut | null>
  orcaStopCut(): Promise<NativeChatOrcaStopCut | null>
  contextFloor(): Promise<AgentJournalCursor | null>
  cursor(): Promise<AgentJournalCursor>
  physicalCursor(): Promise<AgentJournalCursor>
  lastActivityAt(): Promise<number>
  historyOrigin(): Promise<JournalReducerState['historyOrigin']>
  item(itemId: string): Promise<AgentJournalRenderItem | null>
  itemBody(itemId: string): Promise<AgentJournalItemBody | null>
  itemFence(itemId: string): Promise<number | undefined>
  itemProvenance(
    itemId: string
  ): Promise<JournalItemEcho & { ownerFence?: number; executionOwner?: number }>
  hasRecordedItem(itemId: string): Promise<boolean>
  hasItems(): Promise<boolean>
  presentationRemoved(itemId: string): Promise<boolean>
  canonicalItemId(itemId: string): Promise<string>
  canonicalItemIds(
    itemIds: readonly string[]
  ): Promise<readonly { itemId: string; canonicalItemId: string }[]>
  historyItems(
    itemIds: readonly string[],
    options?: JournalHistoryReadOptions
  ): Promise<readonly JournalHistoryItem[]>
  claudeHistoryPrompts(
    sessionId: string,
    uuids: readonly string[]
  ): Promise<readonly JournalHistoryPrompt[]>
  submission(clientMessageId: string): Promise<AgentJournalSubmission | undefined>
  submissionBody(clientMessageId: string): Promise<AgentJournalMessageItem | null>
  receiptFor(clientMessageId: string): Promise<AgentJournalAcceptanceReceipt | null>
  pendingSubmissions(): Promise<AgentJournalSubmission[]>
  lastProviderActivityAt(fence: number): Promise<number | undefined>
  runningTurn(): Promise<{ item: AgentJournalRenderItem; turnId: string } | null>
  newestTurn(): Promise<AgentJournalTurnLifecycle | null>
  namedTurn(turnId: string): Promise<JournalNamedTurn>
  messageOptions(clientMessageId: string): Promise<JournalMessageOptions>
  continuationContext(): Promise<JournalContinuationContext>
  /** The newest presented root user prompt, excluding commands, as restart offers preview it. */
  latestPrompt(): Promise<string>
  restartProgress(cursor: AgentJournalCursor): Promise<JournalRestartProgress>
  outgrownChild(input: JournalOutgrownChildRead): Promise<JournalOutgrownChild>
  threadGoalSource(): Promise<JournalThreadGoalSource>
  /** Saved Claude aliases, attempts, roster and goal, read per acquisition and epoch replacement. */
  claudeSnapshot(): Promise<ClaudeJournalSnapshot>
  contextUsage(): Promise<AgentSessionContextUsage>
  visitItems(filter: JournalItemFilter, visit: JournalItemLinkageVisitor): Promise<void>
}
