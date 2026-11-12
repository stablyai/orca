import type {
  NativeChatMessage,
  NativeChatToolCallBlock
} from '../../../../../src/shared/native-chat/native-chat-types'
import type { NativeChatTaskListPredecessors } from '../../../../../src/shared/native-chat/input/native-chat-task-list-history'
import type { NativeChatResolvedPrompt } from '../../../../../src/shared/native-chat/native-chat-resolution-receipt'
import { isActionableStructuredAgentSessionPrompt } from '../../../../../src/shared/agent-session/view/structured-agent-session-live-turn'
import { nativeChatRowOffersRewind } from '../../../../../src/shared/native-chat/native-chat-rewind-eligibility'
import type { NativeChatTurnStatus } from '../../../../../src/shared/native-chat/transcript/native-chat-turn-status'
import type { NativeChatTurnDiff } from '../../../../../src/shared/native-chat/tools/native-chat-turn-diffs'
import type { MobileStructuredSignedOutRetry } from '../composer/use-mobile-structured-signed-out-retry'

export type MobileNativeChatTurnRow = {
  turnDiff?: NativeChatTurnDiff
  turnStatus: NativeChatTurnStatus | null
  turnStatusAbove?: boolean
  turnExpanded: boolean
  turnKey?: string
  /** The row is the user message its turn starts from, whether or not the turn folds. */
  opensTurn?: true
  activeTurnIsWorking: boolean
  trailingRun: boolean
  workRun?: readonly NativeChatMessage[]
  joinsWorkRun?: boolean
  foldedAway?: boolean
  openReasoning?: ReadonlySet<string>
  mayStillGrow: boolean
  reasoningIsLive: boolean
  reasoningExpanded: boolean
  onToggleReasoning: (key: string) => void
  // Pass roster disclosure only to roster rows so toggles cannot rerender every transcript row.
  subagentGroupsOpen?: ReadonlySet<string>
  onToggleSubagentGroup: (groupId: string) => void
  // Hold expanded user messages above recycled rows so scrolling away cannot collapse them.
  userMessageOpen: boolean
  onToggleUserMessage: (messageId: string) => void
}

/** The message and its derived render inputs share one reuse boundary. */
export type MobileNativeChatRowProps = Omit<MobileNativeChatTurnRow, 'opensTurn'> & {
  message: NativeChatMessage
  rowKey: string
  previousTodoWrite: NativeChatToolCallBlock | undefined
  previousUpdatePlan: NativeChatToolCallBlock | undefined
  unsentNotice: string | undefined
  /** Under the unsent send the host can re-send: its start was refused for want of a login. */
  onRetry?: () => void
  receipt: NativeChatResolvedPrompt | undefined
  awaiting: boolean
  runOwner: string | undefined
  rewindable?: true
}

/** The per-chat lookups a row's props are read from. */
export type MobileNativeChatRowLookups = {
  resolveTurnRow: (index: number, message: NativeChatMessage) => MobileNativeChatTurnRow
  /** The row's place on the page, kept while older messages join it. */
  rowKeyOf: (message: NativeChatMessage) => string
  runOwners: ReadonlyMap<string, string>
  /** The last plan each task-list tool wrote before each row, by row id. */
  taskListPredecessors: ReadonlyMap<string, NativeChatTaskListPredecessors>
  unsentNotices: ReadonlyMap<string, string>
  receipts: ReadonlyMap<string, NativeChatResolvedPrompt> | null
  actionablePromptIds: readonly string[] | undefined
  signedOutRetry: MobileStructuredSignedOutRetry | null
}

/** One row's props: its turn's, plus what the chat's lookups hold for it. */
export function resolveMobileNativeChatRowProps(
  index: number,
  message: NativeChatMessage,
  lookups: MobileNativeChatRowLookups
): MobileNativeChatRowProps {
  const predecessors = lookups.taskListPredecessors.get(message.id)
  const { opensTurn, ...turn } = lookups.resolveTurnRow(index, message)
  const unsentNotice = message.unsent ? lookups.unsentNotices.get(message.id) : undefined
  // The phone nests no subagent sections; the chat's eligible ids still exclude other chats' rows.
  const rewindable = nativeChatRowOffersRewind(
    message,
    { depth: 0, turnKey: opensTurn ? message.id : undefined },
    unsentNotice !== undefined
  )
  return {
    message,
    rowKey: lookups.rowKeyOf(message),
    // The calls, not the record: a rebuilt record would defeat the row's memo.
    previousTodoWrite: predecessors?.todowrite,
    previousUpdatePlan: predecessors?.update_plan,
    unsentNotice,
    ...(unsentNotice !== undefined && lookups.signedOutRetry?.messageId === message.id
      ? { onRetry: lookups.signedOutRetry.retry }
      : {}),
    receipt: lookups.receipts?.get(message.id),
    awaiting: isActionableStructuredAgentSessionPrompt(message.id, lookups.actionablePromptIds),
    ...turn,
    runOwner: lookups.runOwners.get(message.id),
    ...(rewindable ? { rewindable: true as const } : {})
  }
}
