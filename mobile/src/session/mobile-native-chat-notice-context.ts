import { createContext } from 'react'

/** Names a notice row needs: the Orca host behind the chat (null when unnamed) and the agent. */
export type MobileNativeChatNoticeNames = { hostName: string | null; agentName?: string }

export const MobileNativeChatNoticeContext = createContext<MobileNativeChatNoticeNames>({
  hostName: null
})
