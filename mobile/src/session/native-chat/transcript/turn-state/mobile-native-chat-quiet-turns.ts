import type { NativeChatMessage } from '../../../../../../src/shared/native-chat/native-chat-types'
import type { NativeChatTurnStatus } from '../../../../../../src/shared/native-chat/transcript/turns/native-chat-turn-status'
import { nativeChatQuietTurns } from '../../../../../../src/shared/native-chat/transcript/turns/native-chat-quiet-turns'

/** Ids of the rows, and the turns whose bar, a quiet turn hides, as on desktop; a turn with a diff stays. */
export function mobileNativeChatQuietTurns(
  rows: readonly NativeChatMessage[],
  turnKeys: readonly (string | undefined)[],
  completedByTurn: Readonly<Record<string, NativeChatTurnStatus>>,
  turnDiffs: ReadonlyMap<string, unknown>
): { ids: ReadonlySet<string>; turns: ReadonlySet<string> } {
  const settled = new Set(
    Object.entries(completedByTurn).flatMap(([key, status]) =>
      status.workedSeconds != null ? [key] : []
    )
  )
  const changed = new Set(
    rows.flatMap((row, index) => (turnDiffs.get(row.id) !== undefined ? [turnKeys[index]] : []))
  )
  const quiet = nativeChatQuietTurns(rows, turnKeys, settled, (key) => changed.has(key))
  return { ids: new Set([...quiet.rows].map((index) => rows[index]!.id)), turns: quiet.turns }
}
