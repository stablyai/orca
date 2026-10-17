import type { NativeChatTurnJournal } from '../../../src/shared/native-chat-turn-membership'
import { isActionableStructuredAgentSessionPrompt } from '../../../src/shared/structured-agent-session-live-turn'
import { NATIVE_CHAT_STREAMING_ID } from '../../../src/shared/native-chat-streaming'
import { nativeChatRowTurnKeys } from '../../../src/shared/native-chat-turn-grouping'
import { AGENT_SESSION_ORCA_STOP_PRESENTATION } from '../../../src/shared/agent-session-orca-stop'
import { AGENT_SESSION_COMPACTION_SKIPPED_PRESENTATION } from '../../../src/shared/agent-session-compaction'
import {
  deriveNativeChatRowContent,
  nativeChatRowRendersContent
} from '../../../src/shared/native-chat-row-content'
import { isStoppedBeforeStartBlock } from '../../../src/shared/native-chat-stopped-before-start'
import {
  isBackgroundTaskBlock,
  isSubagentGroupBlock,
  type NativeChatMessage
} from '../../../src/shared/native-chat-types'
import {
  nativeChatTurnFold,
  nativeChatTurnAnswerRows
} from '../../../src/shared/native-chat-turn-fold'
import type { NativeChatTurnStatus } from '../../../src/shared/native-chat-turn-status'

/** Use the desktop's turn fold while deriving prose from the phone's rendered blocks. */
export function mobileNativeChatTurnFold(
  messages: readonly NativeChatMessage[],
  turnKeys: readonly (string | undefined)[],
  completed: Readonly<Record<string, NativeChatTurnStatus>>,
  expandedTurnKeys: ReadonlySet<string>,
  preservedRowIds?: ReadonlySet<string>
) {
  const rows = mobileNativeChatTurnRows(messages, turnKeys, preservedRowIds)
  const settledTurnKeys = new Set(
    Object.entries(completed)
      .filter(([, status]) => status.workedSeconds != null)
      .map(([key]) => key)
  )
  const fold = nativeChatTurnFold({ rows, settledTurnKeys, expandedTurnKeys })
  return {
    ...fold,
    answerIds: new Set(
      [...nativeChatTurnAnswerRows(rows)]
        .filter(([key]) => settledTurnKeys.has(key))
        .map(([, index]) => messages[index]!.id)
    )
  }
}

function mobileNativeChatTurnRows(
  messages: readonly NativeChatMessage[],
  turnKeys: readonly (string | undefined)[],
  preservedRowIds?: ReadonlySet<string>
) {
  return messages.map((message, index) => {
    const content = deriveNativeChatRowContent(message.blocks)
    return {
      turnKey: turnKeys[index],
      role: message.role,
      rendersProse: content.markdown.length > 0 || content.hasImages,
      draws: nativeChatRowRendersContent(message.blocks),
      outlivesTurn:
        preservedRowIds?.has(message.id) === true ||
        message.blocks.some(
          (block) =>
            isSubagentGroupBlock(block) ||
            isBackgroundTaskBlock(block) ||
            isStoppedBeforeStartBlock(block)
        ),
      reportsFailure: message.blocks.some(
        (block) =>
          block.type === 'text' &&
          block.tone === 'error' &&
          block.presentation !== AGENT_SESSION_ORCA_STOP_PRESENTATION
      ),
      explainsTurn: message.blocks.some(
        (block) =>
          block.type === 'text' &&
          (block.presentation === 'compaction' ||
            block.presentation === AGENT_SESSION_COMPACTION_SKIPPED_PRESENTATION ||
            block.presentation === AGENT_SESSION_ORCA_STOP_PRESENTATION)
      )
    }
  })
}

/** Bridge history is settled prose; its synthetic streaming row alone is live. */
export function mobileNativeChatBridgeAnswerIds(
  messages: readonly NativeChatMessage[],
  isWorking: boolean
): ReadonlySet<string> {
  const prefixKey = messages[0]?.id
  const keys = nativeChatRowTurnKeys(messages).map((key) => key ?? prefixKey)
  const rows = mobileNativeChatTurnRows(messages, keys)
  if (isWorking) {
    const streaming = rows[messages.findIndex((message) => message.id === NATIVE_CHAT_STREAMING_ID)]
    if (streaming) {
      streaming.rendersProse = false
    }
  }
  return new Set([...nativeChatTurnAnswerRows(rows).values()].map((index) => messages[index]!.id))
}

/** Host actionability outlives the turn while a prompt still awaits an answer. */
export function mobileNativeChatActionablePromptIds(
  journal: NativeChatTurnJournal | null,
  actionablePromptIds: readonly string[] | undefined
): ReadonlySet<string> {
  return new Set(
    (journal?.items ?? [])
      .filter(
        (item) =>
          (item.body.kind === 'approval' || item.body.kind === 'question') &&
          item.body.resolution.state === 'pending' &&
          isActionableStructuredAgentSessionPrompt(item.itemId, actionablePromptIds)
      )
      .map((item) => item.itemId)
  )
}
