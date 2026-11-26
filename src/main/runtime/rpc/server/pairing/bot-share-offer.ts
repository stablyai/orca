// A teammate's device asked to reach a shared bot: its share device row, one per device key on that bot
// and account, with a fresh Relay invite on it. An invite lives ten minutes, so a repeat ask after it
// lapsed mints another on the same row, never a second row.
import type { BotTeamShareOffer } from '../../../../../shared/bots/bot-team-share-seal'
import { isDevicePublicKeyB64 } from '../../../../../shared/remote-runtime/pairing/device-key-proof'
import type { RelayDeviceBinding } from '../../../mobile-cloud-relay/pairing/relay-revoke-outbox'
import type { MobileRelayPairingProvider } from '../runtime-rpc-pairing-types'
import type { BotShareDevice, BotShareDeviceStore, BotShareGrant } from './bot-share-device-store'

/** `devicePublicKey`: the device's Ed25519 key, which it signs in to Relay and this host with. */
export type BotShareOfferAsk = BotShareGrant & { devicePublicKey: string }

type BotShareOfferDeps = {
  store: BotShareDeviceStore
  relay: Pick<MobileRelayPairingProvider, 'createPairingRelay'>
  hostPublicKeyB64: string
  bindRelay: (deviceId: string, binding: RelayDeviceBinding) => Promise<boolean>
  revokeRelay: (binding: RelayDeviceBinding) => void
}

export async function mintBotShareOffer(
  deps: BotShareOfferDeps,
  ask: BotShareOfferAsk
): Promise<BotTeamShareOffer> {
  if (!isDevicePublicKeyB64(ask.devicePublicKey)) {
    throw new Error('invalid_device_key')
  }
  const device = await deps.store.findOrAdd(
    (row) =>
      row.parentDeviceId === undefined &&
      row.devicePublicKeyB64 === ask.devicePublicKey &&
      row.botId === ask.botId &&
      row.accountId === ask.accountId,
    {
      botId: ask.botId,
      accountId: ask.accountId,
      name: ask.name,
      scope: 'runtime',
      devicePublicKeyB64: ask.devicePublicKey
    }
  )
  const { relay, binding } = await deps.relay.createPairingRelay(device.deviceId)
  const current = deps.store.get(device.deviceId)
  if (!current) {
    // Revoked while the invite was minted: the cloud must forget that invite too.
    deps.revokeRelay(binding)
    throw new Error('share_device_revoked')
  }
  if (
    !holdsResumeCredential(current, binding) &&
    !(await deps.bindRelay(device.deviceId, binding))
  ) {
    deps.revokeRelay(binding)
    throw new Error('relay_binding_failed')
  }
  return {
    v: 1,
    botId: device.botId,
    deviceId: device.deviceId,
    hostPublicKeyB64: deps.hostPublicKeyB64,
    relay
  }
}

/** Its 30-day resume credential is installed on this Relay host: an invite's expiry would end the
 *  standing Relay demand it keeps. */
function holdsResumeCredential(device: BotShareDevice, minted: RelayDeviceBinding): boolean {
  const current = device.relayBinding
  return (
    current !== undefined &&
    current.inviteExpiresAt === undefined &&
    current.relayHostId === minted.relayHostId &&
    current.ownerIdentityKey === minted.ownerIdentityKey
  )
}
