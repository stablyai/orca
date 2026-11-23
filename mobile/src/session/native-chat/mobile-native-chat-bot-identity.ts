import { createContext } from 'react'
import type { MobileBotAvatarSource } from '../../bots/host-bot-row-facts'
import type { WaitHostRead } from '../../../../src/shared/automations/automation-chat-row'

export type MobileNativeChatBotIdentity = {
  /** The bot whose chat this is; absent where a row names a bot it doesn't own (a group chat). */
  botId?: string
  showName?: boolean
  name: string
  avatar: MobileBotAvatarSource
  /** Its waits cancelled before they ended, so their rows say so. */
  cancelledWaits?: readonly { automationId: string; at: number }[]
}

export const MobileNativeChatBotIdentityContext = createContext<MobileNativeChatBotIdentity | null>(
  null
)

/** Its host's waits still waiting, so a wait that ran or went elsewhere stops reading Waiting. Apart
 *  from the identity, so each Activity read redraws only the wait rows. */
export const MobileNativeChatBotWaitsContext = createContext<WaitHostRead | null>(null)
