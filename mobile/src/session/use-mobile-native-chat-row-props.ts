import type {
  NativeChatMessage,
  NativeChatToolCallBlock
} from '../../../src/shared/native-chat-types'
import type { NativeChatTaskListPredecessors } from '../../../src/shared/native-chat/input/native-chat-task-list-history'
import type { NativeChatResolvedPrompt } from '../../../src/shared/native-chat-resolution-receipt'
import { isActionableStructuredAgentSessionPrompt } from '../../../src/shared/structured-agent-session-live-turn'
import type { MobileNativeChatTurnRow } from './use-mobile-native-chat-turn-disclosure'

/** The message and its derived render inputs share one reuse boundary. */
export type MobileNativeChatRowProps = MobileNativeChatTurnRow & {
  message: NativeChatMessage
  rowKey: string
  previousTodoWrite: NativeChatToolCallBlock | undefined
  previousUpdatePlan: NativeChatToolCallBlock | undefined
  unsentNotice: string | undefined
  receipt: NativeChatResolvedPrompt | undefined
  awaiting: boolean
  runOwner: string | undefined
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
  const turn = lookups.resolveTurnRow(index, message)
  return {
    message,
    rowKey: lookups.rowKeyOf(message),
    // The calls, not the record: a rebuilt record would defeat the row's memo.
    previousTodoWrite: predecessors?.todowrite,
    previousUpdatePlan: predecessors?.update_plan,
    unsentNotice: message.unsent ? lookups.unsentNotices.get(message.id) : undefined,
    receipt: lookups.receipts?.get(message.id),
    awaiting: isActionableStructuredAgentSessionPrompt(message.id, lookups.actionablePromptIds),
    ...turn,
    runOwner: lookups.runOwners.get(message.id)
  }
}
