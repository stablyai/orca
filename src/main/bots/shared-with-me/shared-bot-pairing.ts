// What this device does next for one shared agent, from its entry and the cloud's latest word on the
// share, and where a message to it goes. Pure, so the order of pairing and hand-off can be tested.
import type { ConnectorSharesMine } from '../../../shared/connector-share-contract'
import { openBotTeamShareOffer } from '../../../shared/bots/bot-team-share-seal'
import { NODE_PAIRED_E2EE_PRIMITIVES } from '../../../shared/remote-runtime/e2ee/node/paired-e2ee-node-primitives'
import { SHARED_HOSTS_HOLD_WHILE_AWAY } from '../../../shared/bots/shared-bot-hosts'
import type { SharedHostRelayCredential } from '../../../shared/remote-runtime/relay/client/shared-host-relay-connection'
import type { SharedHostLink } from '../../../shared/remote-runtime/relay/client/shared-host-relay-link'
import {
  sharedBotHostKey,
  type SharedBotHeldMessage,
  type SharedBotHostEntry
} from './shared-bot-host-store'

export type MineShare = ConnectorSharesMine['shares'][number]

/** The host's offer to this device: one newly opened, else the one held. Once paired the host's key
 *  is pinned: the cloud knows the seal key, so an offer under another key may be its own. */
export function pinnedSharedBotOffer(
  entry: Pick<SharedBotHostEntry, 'deviceKey' | 'sealKey' | 'offer'>,
  share: Pick<MineShare, 'botId' | 'offers'>
): SharedBotHostEntry['offer'] {
  const pinned = entry.offer?.hostPublicKeyB64
  return (
    share.offers
      ?.filter((candidate) => candidate.devicePublicKey === entry.deviceKey.publicKeyB64)
      .map((candidate) =>
        openBotTeamShareOffer(NODE_PAIRED_E2EE_PRIMITIVES, {
          sealSecretKey: Buffer.from(entry.sealKey.secretKeyB64, 'base64'),
          sealed: candidate.sealedOffer,
          expect: { botId: share.botId }
        })
      )
      .find(
        (opened) => opened !== null && (pinned === undefined || opened.hostPublicKeyB64 === pinned)
      ) ?? entry.offer
  )
}

/** How this device reaches the host now: see `SharedHostLink`. */
export type SharedBotLink = SharedHostLink

// An accept waits up to a day for the host, so it is asked again only this often while unanswered.
export const ACCEPT_RETRY_MS = 5 * 60 * 1000

export type PairingStep =
  | { kind: 'connect'; credential: SharedHostRelayCredential }
  | { kind: 'accept' }
  | { kind: 'wait' }

/**
 * A resume credential connects. Else an unexpired invite does. Else the device asks the host (again,
 * with the same keys) for an offer: at once the first time, and after an expired invite only while
 * the host is online, at most once per ACCEPT_RETRY_MS.
 */
export function nextPairingStep(
  entry: SharedBotHostEntry,
  share: Pick<MineShare, 'hostOnline'>,
  now: number
): PairingStep {
  if (entry.resume && entry.offer) {
    return {
      kind: 'connect',
      credential: { kind: 'resume', token: entry.resume.token, version: entry.resume.version }
    }
  }
  const { offer } = entry
  if (
    offer &&
    offer.relay.inviteExpiresAt > now &&
    offer.relay.inviteToken !== entry.refusedInvite
  ) {
    return {
      kind: 'connect',
      credential: { kind: 'invite', inviteToken: offer.relay.inviteToken }
    }
  }
  if (entry.acceptedAt === undefined) {
    return { kind: 'accept' }
  }
  const askedRecently = now - entry.acceptedAt < ACCEPT_RETRY_MS
  return share.hostOnline && !askedRecently ? { kind: 'accept' } : { kind: 'wait' }
}

type HeldChat = SharedBotHeldMessage['chat']

/** The chat a held message lands in: its session, a new chat's once the host started it, else its
 *  placeholder id (the namespaces never meet). */
export function sharedBotHeldChatId(
  held: Pick<SharedBotHeldMessage, 'chat' | 'startedAs'>
): string {
  return 'sessionId' in held.chat ? held.chat.sessionId : (held.startedAs ?? held.chat.newChatId)
}

/**
 * Whether a message goes to Orca Cloud's held queue instead of the relay. Only with the host's key
 * (no key, nothing can be sealed to it). Then: whenever the host can't be reached live, for a new chat
 * the host hasn't started yet, and while an earlier held message in the same chat hasn't landed, so a
 * later one never overtakes it.
 */
export function sendsHeld(
  entry: Pick<SharedBotHostEntry, 'offer' | 'hostKey' | 'held'>,
  link: SharedBotLink,
  chat: HeldChat,
  heldStates: ReadonlyMap<string, MineShare['held'][number]['state']>
): boolean {
  if (!SHARED_HOSTS_HOLD_WHILE_AWAY || !sharedBotHostKey(entry)) {
    return false
  }
  if (link !== 'live' || 'newChatId' in chat) {
    return true
  }
  const chatId = sharedBotHeldChatId({ chat })
  return entry.held.some(
    (held) =>
      sharedBotHeldChatId(held) === chatId &&
      (heldStates.get(held.clientMessageId) ?? 'waiting') === 'waiting'
  )
}
