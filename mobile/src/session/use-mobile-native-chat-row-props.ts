import { useLayoutEffect, useRef } from 'react'
import {
  projectMobileNativeChatRows,
  type MobileNativeChatRowProjection
} from './mobile-native-chat-row-projection'
import type {
  NativeChatMessage,
  NativeChatToolCallBlock
} from '../../../src/shared/native-chat-types'
import type { NativeChatTaskListPredecessors } from '../../../src/shared/native-chat-task-list-history'
import type { NativeChatResolvedPrompt } from '../../../src/shared/native-chat-resolution-receipt'
import { isActionableStructuredAgentSessionPrompt } from '../../../src/shared/structured-agent-session-live-turn'
import type { MobileNativeChatRowItemSource } from './MobileNativeChatRowItemSource'
import type { ContextType } from 'react'
import type { MobileNativeChatItemSourceContext } from './mobile-native-chat-item-read'
import type { MobileNativeChatTurnRow } from './use-mobile-native-chat-turn-disclosure'

/** The message and its derived render inputs share one reuse boundary. */
export type MobileNativeChatRowProps = MobileNativeChatTurnRow & {
  message: NativeChatMessage
  itemSource: MobileNativeChatRowItemSource | null
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
  itemSource?: ContextType<typeof MobileNativeChatItemSourceContext>
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
  const source = lookups.itemSource
  const detail = source?.messageDetail
  return {
    message,
    itemSource: source
      ? {
          client: source.client,
          sessionId: source.sessionId,
          details: (turn.workRun ?? [message]).map((member) => {
            const raw = detail?.raw(member.id)
            return {
              id: member.id,
              raw: raw?.shortened ? raw : undefined,
              state: detail?.state(member.id) ?? null
            }
          })
        }
      : null,
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

// Commit-scoped sharing prevents abandoned renders or another chat from becoming the reuse baseline.
export function useMobileNativeChatRowProps(
  messages: readonly NativeChatMessage[],
  lookups: MobileNativeChatRowLookups,
  scope: string
): MobileNativeChatRowProjection<MobileNativeChatRowProps> {
  const source = lookups.itemSource
  const detail = source?.messageDetail
  const inputs: Readonly<Record<string, unknown>> = {
    messages,
    ...lookups,
    detailClient: source?.client,
    detailSession: source?.sessionId,
    detailService: detail,
    detailRaw: detail?.raw,
    detailState: detail?.state,
    detailLoad: detail?.load
  }
  const committed = useRef<{
    scope: string
    inputs: typeof inputs
    projection: MobileNativeChatRowProjection<MobileNativeChatRowProps>
  } | null>(null)
  const previous = committed.current
  const sameScope = previous !== null && previous.scope === scope
  const projection =
    sameScope &&
    Object.keys(inputs).length === Object.keys(previous.inputs).length &&
    Object.entries(inputs).every(([key, value]) => value === previous.inputs[key])
      ? previous.projection
      : projectMobileNativeChatRows(
          messages.map((message, index) =>
            resolveMobileNativeChatRowProps(index, message, lookups)
          ),
          sameScope ? previous.projection : undefined
        )
  useLayoutEffect(() => {
    committed.current = { scope, inputs, projection }
  })
  return projection
}
