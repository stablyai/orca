import { createContext } from 'react'
import type { MobileStructuredInterruptedContinue } from '../../composer/delivery/use-mobile-structured-interrupted-continue'
import type { MobileNativeChatUsageLimit } from '../../status/use-mobile-native-chat-usage-limit'

/** What a notice row needs: the Orca host behind the chat (null when unnamed), the agent, and Continue for an Orca-stopped turn. */
export type MobileNativeChatNoticeView = {
  hostName: string | null
  agentName?: string
  continuation?: Pick<
    MobileStructuredInterruptedContinue,
    'continueAvailable' | 'offeredTurnItemId' | 'continueNow'
  >
  /** Opens a host terminal tab in the chat's workspace running `command`. */
  onRunInTerminal?: (command: string) => void
  /** The usage-limit row the person can act on; null when none can be. */
  usageLimit?: MobileNativeChatUsageLimit | null
  /** Opens the accounts of the host that runs this chat; absent when the phone can't reach them. */
  openAccounts?: () => void
}

export const MobileNativeChatNoticeContext = createContext<MobileNativeChatNoticeView>({
  hostName: null
})

/** Opens the chat a "Forked from" divider names; absent where the view cannot open chats. */
export const MobileNativeChatForkedFromContext = createContext<
  ((sourceSessionId: string) => void) | undefined
>(undefined)
