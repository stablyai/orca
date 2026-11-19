import type { NativeChatMessage } from '../../../../../../src/shared/native-chat/native-chat-types'
import type { NativeChatTurnStatus } from '../../../../../../src/shared/native-chat/transcript/turns/native-chat-turn-status'
import { nativeChatQuietTurns } from '../../../../../../src/shared/native-chat/transcript/turns/native-chat-quiet-turns'
import { nativeChatEventPlan } from '../../../../../../src/shared/native-chat/transcript/events/native-chat-event-plan'

/** What the phone leaves out, as on desktop: the rows and the bar of a quiet turn (a turn with a diff
 *  stays), and rows merged into a later row about the same Dispatch or run (`shown` carries the
 *  merges). The phone reads no worker list, so only rows that name their Dispatch or run merge. */
export function mobileNativeChatQuietTurns(
  rows: readonly NativeChatMessage[],
  turnKeys: readonly (string | undefined)[],
  completedByTurn: Readonly<Record<string, NativeChatTurnStatus>>,
  turnDiffs: ReadonlyMap<string, unknown>
): {
  ids: ReadonlySet<string>
  turns: ReadonlySet<string>
  shown: readonly NativeChatMessage[]
} {
  const settled = new Set(
    Object.entries(completedByTurn).flatMap(([key, status]) =>
      status.workedSeconds != null ? [key] : []
    )
  )
  const changed = new Set(
    rows.flatMap((row, index) => (turnDiffs.get(row.id) !== undefined ? [turnKeys[index]] : []))
  )
  const quiet = nativeChatQuietTurns(rows, turnKeys, settled, (key) => changed.has(key))
  const shown = nativeChatEventPlan(rows, {
    turnKeys,
    workers: [],
    quiet,
    turnEndsDrawing: (key) => changed.has(key)
  })
  const ids = new Set([...quiet.rows].map((index) => rows[index]!.id))
  for (const row of shown) {
    if (row.mergedInto !== undefined) {
      ids.add(row.id)
    }
  }
  return { ids, turns: quiet.turns, shown }
}
