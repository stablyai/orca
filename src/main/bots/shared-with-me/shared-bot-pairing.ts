// What this device does next for one shared agent, from its entry and the cloud's latest word on the
// share, and where a message to it goes. Pure, so the order of pairing and hand-off can be tested.
import type { ConnectorSharesMine } from '../../../../cloud/packages/connector-contract/src/share-messages'
import type { SharedHostRelayCredential } from '../../../shared/remote-runtime/relay/client/shared-host-relay-connection'
import type { SharedBotHeldMessage, SharedBotHostEntry } from './shared-bot-host-store'

export type MineShare = ConnectorSharesMine['shares'][number]

/** How this device reaches the host now. `unpaired`: no usable offer or resume credential yet. */
export type SharedBotLink = 'live' | 'connecting' | 'offline' | 'unpaired'

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

/**
 * The relay refused the credential (an expired or spent invite, a revoked resume): drop it, so the
 * next step accepts again with the same keys rather than dialing it forever. The offer stays: its
 * host key and device id still name this device's row on the host.
 */
export function withoutRefusedCredential(
  entry: SharedBotHostEntry,
  credential: SharedHostRelayCredential
): SharedBotHostEntry {
  if (credential.kind === 'resume') {
    const { resume: _resume, ...rest } = entry
    return rest
  }
  return { ...entry, refusedInvite: credential.inviteToken }
}

type HeldChat = SharedBotHeldMessage['chat']

const sameChat = (a: HeldChat, b: HeldChat): boolean =>
  'sessionId' in a && 'sessionId' in b
    ? a.sessionId === b.sessionId
    : 'newChatId' in a && 'newChatId' in b && a.newChatId === b.newChatId

/**
 * Whether a message goes to Orca Cloud's held queue instead of the relay. Only with the host's key
 * (no key, nothing can be sealed to it). Then: whenever the host can't be reached live, and also while
 * an earlier held message in the same chat hasn't landed, so a later one never overtakes it.
 */
export function sendsHeld(
  entry: Pick<SharedBotHostEntry, 'hostKey' | 'held'>,
  link: SharedBotLink,
  chat: HeldChat,
  heldStates: ReadonlyMap<string, MineShare['held'][number]['state']>
): boolean {
  if (!entry.hostKey) {
    return false
  }
  if (link !== 'live') {
    return true
  }
  return entry.held.some(
    (held) =>
      sameChat(held.chat, chat) && (heldStates.get(held.clientMessageId) ?? 'waiting') === 'waiting'
  )
}
