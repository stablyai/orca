// What this device does next for one shared agent, from its entry and the cloud's latest word on the
// share, and where a message to it goes. Pure, so the order of pairing and hand-off can be tested.
import type { ConnectorSharesMine } from '../../../shared/connector-share-contract'
import { openBotTeamShareOffer } from '../../../shared/bots/bot-team-share-seal'
import { NODE_PAIRED_E2EE_PRIMITIVES } from '../../../shared/remote-runtime/e2ee/node/paired-e2ee-node-primitives'
import type { SharedHostRelayCredential } from '../../../shared/remote-runtime/relay/client/shared-host-relay-connection'
import type { SharedHostLink } from '../../../shared/remote-runtime/relay/client/shared-host-relay-link'
import { sendsHeldTo } from '../../../shared/bots/shared-bot-held-routing'
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

export { sharedBotHeldChatId } from '../../../shared/bots/shared-bot-held-routing'

/** Whether a message to `entry`'s host is held: see `sendsHeldTo`. */
export function sendsHeld(
  entry: Pick<SharedBotHostEntry, 'offer' | 'hostKey' | 'held'>,
  link: SharedBotLink,
  chat: SharedBotHeldMessage['chat'],
  heldStates: ReadonlyMap<string, MineShare['held'][number]['state']>
): boolean {
  return sendsHeldTo(sharedBotHostKey(entry), entry.held, link, chat, heldStates)
}

// New shares and invites resolve within this; pairing and held messages are read sooner.
const IDLE_POLL_MS = 10 * 60 * 1000
const BUSY_POLL_MS = 30 * 1000
// Just after an Accept the host mints its offer within seconds; reading at the busy pace left the
// agent Disconnected for up to half a minute after that.
const ACCEPTING_POLL_MS = 2 * 1000
const ACCEPTING_WINDOW_MS = 2 * 60 * 1000

/** Whether `entry` was accepted moments ago and waits for its first link: shown as connecting, not
 *  away, and its share list read fast so the host's offer is dialed within seconds. */
export function sharedBotAccepting(
  entry: { resume?: unknown; acceptedAt?: number },
  link: string,
  now: number
): boolean {
  return (
    !entry.resume &&
    link !== 'live' &&
    entry.acceptedAt !== undefined &&
    now - entry.acceptedAt < ACCEPTING_WINDOW_MS
  )
}

/** How long until the next read of the share list: soon while one is pairing, has a held message or
 *  its host is away, so each settles without a click; sooner still while an Accept awaits its offer. */
export function sharedBotsPollMs<E extends { resume?: unknown; acceptedAt?: number }>(
  now: number,
  entries: readonly E[],
  state: (entry: E) => { link: string; waiting: boolean }
): number {
  const states = entries.map((entry) => ({ entry, ...state(entry) }))
  if (states.some(({ entry, link }) => sharedBotAccepting(entry, link, now))) {
    return ACCEPTING_POLL_MS
  }
  return states.some(({ entry, link, waiting }) => !entry.resume || link !== 'live' || waiting)
    ? BUSY_POLL_MS
    : IDLE_POLL_MS
}
