import type {
  NativeChatMessage,
  NativeChatToolCallBlock
} from '../../../../../../src/shared/native-chat/native-chat-types'
import type { NativeChatTaskListPredecessors } from '../../../../../../src/shared/native-chat/input/task-lists/native-chat-task-list-history'
import type { NativeChatResolvedPrompt } from '../../../../../../src/shared/native-chat/input/questions/native-chat-resolution-receipt'
import { isActionableStructuredAgentSessionPrompt } from '../../../../../../src/shared/agent-session/view/structured-agent-session-live-turn'
import { nativeChatRowOffersRewind } from '../../../../../../src/shared/native-chat/transcript/turns/native-chat-rewind-eligibility'
import type { NativeChatTurnStatus } from '../../../../../../src/shared/native-chat/transcript/turns/native-chat-turn-status'
import type { NativeChatTurnDiff } from '../../../../../../src/shared/native-chat/tools/native-chat-turn-diffs'
import type { NativeChatActivityJoin } from '../../../../../../src/shared/native-chat/transcript/events/native-chat-activity-rows'
import { translate } from '../../../../i18n/mobile-i18n'

export type MobileNativeChatMessageProps = {
  message: NativeChatMessage
  // Stable placement key survives older messages joining a folded row.
  rowKey?: string
  runOwner?: string
  // Only the newest live assistant row can still grow.
  mayStillGrow?: boolean
  // Compare plan updates against the prior write, not an empty checklist.
  previousTodoWrite?: NativeChatToolCallBlock
  previousUpdatePlan?: NativeChatToolCallBlock
  fontScale?: number
  turnStatus?: NativeChatTurnStatus | null
  turnStatusAbove?: boolean
  turnExpanded?: boolean
  turnKey?: string
  /** The chat may rewind to this row, by desktop's `nativeChatRowOffersRewind`. */
  rewindable?: true
  onToggleTurn?: (turnKey: string) => void
  activeTurnIsWorking?: boolean
  trailingRun?: boolean
  // The run’s first row draws all members; later members render no duplicate activity.
  workRun?: readonly NativeChatMessage[]
  joinsWorkRun?: boolean
  foldedAway?: boolean
  openReasoning?: ReadonlySet<string>
  structuredActivityUi?: boolean
  // Hide the reasoning row while the live activity line discloses the same block.
  reasoningIsLive?: boolean
  reasoningExpanded?: boolean
  onToggleReasoning?: (key: string) => void
  unsentNotice?: string
  receipt?: NativeChatResolvedPrompt
  awaiting?: boolean
  userMessageOpen?: boolean
  onToggleUserMessage?: (messageId: string) => void
  /** A group room draws one time line per turn; otherwise the time line always shows, so the row never shifts when copy appears. */
  withoutMeta?: true
}

export type MobileNativeChatTurnRow = {
  turnDiff?: NativeChatTurnDiff
  turnStatus: NativeChatTurnStatus | null
  turnStatusAbove?: boolean
  turnExpanded: boolean
  turnKey?: string
  /** The row is the user message its turn starts from, whether or not the turn folds. */
  opensTurn?: true
  /** An automation's row opened the turn. */
  inAutomationTurn?: true
  /** The turn said something or did something others see. */
  inActingTurn?: true
  activeTurnIsWorking: boolean
  trailingRun: boolean
  workRun?: readonly NativeChatMessage[]
  joinsWorkRun?: boolean
  /** The sides where this activity row touches another, which sit close. */
  activityJoin?: NativeChatActivityJoin
  foldedAway?: boolean
  openReasoning?: ReadonlySet<string>
  mayStillGrow: boolean
  reasoningIsLive: boolean
  reasoningExpanded: boolean
  onToggleReasoning: (key: string) => void
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
}

/** One row's props: its turn's, plus what the chat's lookups hold for it. */
export function resolveMobileNativeChatRowProps(
  index: number,
  message: NativeChatMessage,
  lookups: MobileNativeChatRowLookups
): MobileNativeChatRowProps {
  const predecessors = lookups.taskListPredecessors.get(message.id)
  const { opensTurn, ...turn } = lookups.resolveTurnRow(index, message)
  const unsentNotice = message.retainedSendId
    ? translate('chat.message.deliveryUnconfirmed', 'Delivery unconfirmed')
    : message.unsent
      ? lookups.unsentNotices.get(message.id)
      : undefined
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
    receipt: lookups.receipts?.get(message.id),
    awaiting: isActionableStructuredAgentSessionPrompt(message.id, lookups.actionablePromptIds),
    ...turn,
    runOwner: lookups.runOwners.get(message.id),
    ...(rewindable ? { rewindable: true as const } : {})
  }
}
