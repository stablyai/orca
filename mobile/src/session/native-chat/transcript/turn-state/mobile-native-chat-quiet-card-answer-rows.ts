import type { NativeChatMessage } from '../../../../../../src/shared/native-chat/native-chat-types'
import type { NativeChatTurnStatus } from '../../../../../../src/shared/native-chat/transcript/turns/native-chat-turn-status'
import { nativeChatQuietCardAnswerRows } from '../../../../../../src/shared/native-chat/transcript/turns/native-chat-quiet-card-answer-turns'

/** Ids of the rows a quiet card-answer turn hides, as on desktop; a turn with a diff stays. */
export function mobileNativeChatQuietCardAnswerIds(
  rows: readonly NativeChatMessage[],
  turnKeys: readonly (string | undefined)[],
  completedByTurn: Readonly<Record<string, NativeChatTurnStatus>>,
  turnDiffs: ReadonlyMap<string, unknown>
): ReadonlySet<string> {
  const settled = new Set(
    Object.entries(completedByTurn).flatMap(([key, status]) =>
      status.workedSeconds != null ? [key] : []
    )
  )
  const changed = new Set(
    rows.flatMap((row, index) => (turnDiffs.get(row.id) !== undefined ? [turnKeys[index]] : []))
  )
  const hidden = nativeChatQuietCardAnswerRows(rows, turnKeys, settled, (key) => changed.has(key))
  return new Set([...hidden].map((index) => rows[index]!.id))
}
