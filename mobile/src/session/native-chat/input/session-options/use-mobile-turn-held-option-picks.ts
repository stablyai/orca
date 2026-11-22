import { useEffect } from 'react'
import {
  dropNativeChatTurnHeldOptionPicks,
  type NativeChatTurnHeldOptionSurface
} from '../../../../../../src/shared/native-chat/input/session-options/native-chat-turn-held-option-surface'

/** Holds picks while the agent works; another chat or agent drops picks still waiting for this one's turn. */
export function useMobileTurnHeldOptionPicks(
  surface: NativeChatTurnHeldOptionSurface | null,
  identity: string | null,
  isWorking: boolean
): void {
  useEffect(() => {
    surface?.setWorking(isWorking)
  }, [isWorking, surface])
  useEffect(
    () => () => {
      if (identity) {
        dropNativeChatTurnHeldOptionPicks(identity)
      }
    },
    [identity]
  )
}
