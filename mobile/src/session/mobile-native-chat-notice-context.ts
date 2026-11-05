import { createContext } from 'react'
import type { MobileStructuredInterruptedContinue } from './use-mobile-structured-interrupted-continue'

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
}

export const MobileNativeChatNoticeContext = createContext<MobileNativeChatNoticeView>({
  hostName: null
})
