import { useMemo } from 'react'
import type { NativeChatMessage } from '../../../../../src/shared/native-chat/native-chat-types'
import {
  nativeChatTurnMembership,
  type NativeChatTurnJournal
} from '../../../../../src/shared/native-chat/transcript/native-chat-turn-membership'
import { nativeChatRowsInDrawOrder } from '../../../../../src/shared/native-chat/transcript/native-chat-turn-grouping'

const NO_TURN_KEYS: readonly undefined[] = []

/** Resolve the chat's rows in draw order with their turn keys, live turn and journal-bound fact. */
export function useMobileNativeChatTurnRows({
  messages,
  enabled,
  turnJournal
}: {
  messages: readonly NativeChatMessage[]
  enabled: boolean
  turnJournal?: NativeChatTurnJournal | null
}): {
  rows: readonly NativeChatMessage[]
  turnKeys: readonly (string | undefined)[]
  liveTurnKey: string | undefined
  unresolvedRowIds: ReadonlySet<string> | undefined
  partialTurnKey: string | undefined
  providerTurnBoundsKnown: boolean
} {
  return useMemo(() => {
    if (!enabled) {
      return {
        rows: messages,
        turnKeys: NO_TURN_KEYS,
        liveTurnKey: undefined,
        unresolvedRowIds: undefined,
        partialTurnKey: undefined,
        providerTurnBoundsKnown: false
      }
    }
    const membership = nativeChatTurnMembership(messages, turnJournal)
    return {
      rows: nativeChatRowsInDrawOrder(messages, membership.drawOrder),
      turnKeys: nativeChatRowsInDrawOrder(membership.turnKeys, membership.drawOrder),
      liveTurnKey: membership.liveTurnKey,
      partialTurnKey: membership.partialTurnKey,
      unresolvedRowIds: membership.unresolvedRowIds,
      providerTurnBoundsKnown: membership.providerTurnBoundsKnown
    }
  }, [enabled, messages, turnJournal])
}
