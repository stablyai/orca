import { createContext, useContext } from 'react'
import type { ExecutionHostId } from '../../../../../../src/shared/execution-host/execution-host'
import type { RpcClient } from '../../../../transport/rpc/rpc-client-contract'
import type { BotAgent } from '../../../../../../src/shared/bot-types'
import type { BotProposal } from '../../../../../../src/shared/bots/bot-proposal'

/** Where a chat's bot cards act: the chat's own execution host, which runs every bot they name. */
export type MobileBotCardHost = {
  client: RpcClient | null
  /** `hostBotsKey` for the chat's execution host, so a card's edit reaches every screen at once. */
  hostKey: string
  pairedHostId: string
  /** The server the chat runs on; absent for the desktop's own. */
  executionHost?: ExecutionHostId
  /** The computer's name, for Runs on. */
  hostLabel: string
  /** Opens one of a bot's chats on this host, or its Home when that chat can't open. */
  openBotChat: (
    bot: { id: string; name: string; folderWorkspaceId: string },
    chatId: string
  ) => void
  /** Opens New bot filled from an offer card, held by the chat so it outlives the card's row. */
  editOffer: (offer: MobileBotCardOfferEdit) => void
  /** Opens the Automations page; absent for a chat another server runs, whose automations it doesn't list. */
  openAutomations?: () => void
}

export type MobileBotCardOfferEdit = {
  proposal: BotProposal
  /** Absent when the proposer's agent is one this build doesn't know. */
  agent?: BotAgent
  fromOffer: { botId: string; offerId: string }
  origin: string
  templatePackages: boolean
}

export const MobileBotCardHostContext = createContext<MobileBotCardHost | null>(null)

export function useMobileBotCardHost(): MobileBotCardHost | null {
  return useContext(MobileBotCardHostContext)
}

/** Tells the chat's agent `text`, as if typed; resolves false when the chat refused it. Null outside a chat. */
export const MobileBotCardSendContext = createContext<((text: string) => Promise<boolean>) | null>(
  null
)
