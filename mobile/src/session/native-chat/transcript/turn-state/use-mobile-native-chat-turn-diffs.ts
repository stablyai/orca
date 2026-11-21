import { useMemo } from 'react'
import type { NativeChatMessage } from '../../../../../../src/shared/native-chat/native-chat-types'
import { nativeChatTurnMembership } from '../../../../../../src/shared/native-chat/transcript/turns/native-chat-turn-membership'
import {
  nativeChatTurnDiffs,
  type NativeChatTurnDiff
} from '../../../../../../src/shared/native-chat/tools/native-chat-turn-diffs'

export function useMobileNativeChatTurnDiffs(
  rows: readonly NativeChatMessage[],
  structured: boolean,
  shown: boolean,
  turnKeys: readonly (string | undefined)[],
  partialTurnKey: string | undefined
) {
  return useMemo(() => {
    if (!shown) {
      return new Map<string, NativeChatTurnDiff | undefined>()
    }
    const keys = structured ? turnKeys : nativeChatTurnMembership(rows, null).turnKeys
    const diffs = nativeChatTurnDiffs(rows, keys, undefined, partialTurnKey)
    const lastRows = new Map<string, string>()
    rows.forEach((row, index) => {
      const key = keys[index]
      if (key !== undefined) {
        lastRows.set(key, row.id)
      }
    })
    return new Map(Array.from(lastRows, ([key, id]) => [id, diffs.get(key)]))
  }, [shown, structured, partialTurnKey, rows, turnKeys])
}
