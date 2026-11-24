// A shared bot's deliveries on its host: an invite that signed in as an Orca account, and a
// teammate's device asking to reach the bot. Each is done only once handled, so the share's next
// delivery waits for it.
import { botAccountShare, withBotShareResolved } from '../../shared/bots/bot-team-shares'
import type { ConnectorDelivery } from '../../shared/connectors/connector-cloud-contract'
import type { Bot } from '../../shared/bot-types'
import * as z from 'zod'
import {
  shareOfferPath,
  type ConnectorShareOfferRequest
} from '../../shared/connector-share-contract'
import type { ConnectorCloud } from '../connector-cloud/connector-cloud'
import {
  sealBotTeamShareOffer,
  type BotTeamShareOffer
} from '../../shared/bots/bot-team-share-seal'
import { NODE_PAIRED_E2EE_PRIMITIVES } from '../../shared/remote-runtime/e2ee/node/paired-e2ee-node-primitives'
import type { BotHostUpdates } from '../../shared/rpc-contract/bots-params'

type ShareResolved = Extract<ConnectorDelivery, { kind: 'share_resolved' }>
type ShareAccept = Extract<ConnectorDelivery, { kind: 'share_accept' }>

/** Rewrites the invite as the account; false once it was removed or is another email's. */
export async function resolveBotShareInvite(
  bots: {
    list: () => readonly Pick<Bot, 'id' | 'shares'>[]
    // BotController.update: the edit reads the bot as saved, inside its write queue.
    update: (
      botId: string,
      edit: (saved: Pick<Bot, 'shares'>) => Pick<BotHostUpdates, 'shares'>
    ) => Promise<unknown>
  },
  delivery: ShareResolved
): Promise<boolean> {
  const bot = bots.list().find((entry) => entry.id === delivery.botId)
  const shares = bot?.shares ?? []
  const next = bot ? withBotShareResolved(shares, delivery) : null
  if (!bot || next === null) {
    return false
  }
  if (next === shares) {
    return true
  }
  let resolved = false
  // Applied again to the list as saved, so a removal that landed meanwhile wins.
  await bots.update(bot.id, (saved) => {
    const latest = withBotShareResolved(saved.shares ?? [], delivery)
    resolved = latest !== null
    return latest && latest !== saved.shares ? { shares: [...latest] } : {}
  })
  return resolved
}

/**
 * Binds a teammate's device to a share and mints what it connects with. One row per
 * `(devicePublicKey, botId, accountId)`, so one device key can reach several shared agents: a
 * repeat accept for the same three (its relay invite expired before the teammate's Orca used it)
 * reuses that row and mints a fresh invite, never a second row. Each call returns a new offer.
 */
export type BotShareOfferMint = (input: {
  botId: string
  accountId: string
  /** The teammate as the share names them. */
  name: string
  devicePublicKey: string
}) => Promise<BotTeamShareOffer>

export type BotShareAcceptDeps = {
  bots: { list: () => readonly Pick<Bot, 'id' | 'shares'>[] }
  mintOffer: BotShareOfferMint
  /** putBotShareOffer, as the signed-in account. */
  putOffer: (
    botId: string,
    shareId: string,
    request: ConnectorShareOfferRequest
  ) => Promise<{ ok: true } | { ok: false; error: string }>
}

/** PUTs the sealed offer for the teammate's next shares read. */
export async function putBotShareOffer(
  cloud: Pick<ConnectorCloud, 'call'> | null,
  botId: string,
  shareId: string,
  request: ConnectorShareOfferRequest
): Promise<{ ok: true } | { ok: false; error: string }> {
  const sent = cloud
    ? await cloud.call(shareOfferPath(botId, shareId), request, z.undefined(), { method: 'PUT' })
    : null
  return sent?.ok ? { ok: true } : { ok: false, error: sent?.error ?? 'offer_not_sent' }
}

/** Answers the accept with an offer sealed to the device; false once the share isn't that account's. */
export async function acceptBotShare(
  deps: BotShareAcceptDeps,
  delivery: ShareAccept
): Promise<boolean> {
  const bot = deps.bots.list().find((entry) => entry.id === delivery.botId)
  const share = botAccountShare(bot?.shares, delivery.shareId, delivery.accountId)
  if (!share) {
    return false
  }
  const offer = await deps.mintOffer({
    botId: delivery.botId,
    accountId: share.accountId,
    name: share.name ?? share.email,
    devicePublicKey: delivery.devicePublicKey
  })
  const request: ConnectorShareOfferRequest = {
    v: 1,
    devicePublicKey: delivery.devicePublicKey,
    sealedOffer: sealBotTeamShareOffer(NODE_PAIRED_E2EE_PRIMITIVES, {
      sealKey: delivery.sealKey,
      offer
    })
  }
  const sent = await deps.putOffer(delivery.botId, delivery.shareId, request)
  if (!sent.ok) {
    // Refused with why: the teammate's Orca asks again, with the same key.
    throw new Error(sent.error)
  }
  return true
}
