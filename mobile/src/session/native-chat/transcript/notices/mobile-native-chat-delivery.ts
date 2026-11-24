// Messages a chat's view draws that its host hasn't recorded yet, each with its word: a teammate's
// messages held for a shared agent's host while it is away. The host's own row replaces each one.
import { createContext } from 'react'
import type { MobileNativeChatPendingItem } from '../projection/mobile-native-chat-render-data'

/** Under a held message: still waiting, or not sent with Send again. */
export type MobileNativeChatDeliveryNotice = {
  text: string
  waiting: boolean
  /** Resolves false when it couldn't be sent again. */
  onSendAgain?: () => Promise<boolean>
}

export type MobileNativeChatDelivery = {
  /** Drawn after the chat's rows as sent messages. */
  pending: readonly MobileNativeChatPendingItem[]
  /** By row id: `agentJournalSubmissionKey` of the message's client id, as its host's row is keyed. */
  notices: ReadonlyMap<string, MobileNativeChatDeliveryNotice>
}

export const MobileNativeChatDeliveryContext = createContext<MobileNativeChatDelivery | null>(null)
