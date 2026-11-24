// A teammate's computer asks for a key for its phone: a child of its own share device row, bound to the
// same bot and account, whose share credential Orca Cloud holds before the phone hears of it.
import type { Bot } from '../../../../../shared/bot-types'
import {
  sealBotTeamShareOffer,
  type BotTeamShareOffer
} from '../../../../../shared/bots/bot-team-share-seal'
import type {
  BotShareProvisionedPhone,
  BotShareProvisionPhoneParams
} from '../../../../../shared/bots/bot-share-phone'
import { NODE_PAIRED_E2EE_PRIMITIVES } from '../../../../../shared/remote-runtime/e2ee/node/paired-e2ee-node-primitives'
import type { BotSharePhoneCredential } from '../../../../bots/team-share/bot-share-phone-credentials'
import { bindBotShareDevice, inviteBotShareDevice, type BotShareOfferDeps } from './bot-share-offer'

export type BotSharePhoneDeps = BotShareOfferDeps & {
  bots: () => readonly Pick<Bot, 'id' | 'shares'>[]
  installCredential: (phone: BotSharePhoneCredential, credentialHash: string) => Promise<boolean>
  /** Ends the account's devices on the bot, as removing its share does. */
  revokeDevices: (botId: string, accountId: string) => Promise<boolean>
}

export async function provisionBotSharePhone(
  deps: BotSharePhoneDeps,
  parentDeviceId: string,
  params: BotShareProvisionPhoneParams
): Promise<BotShareProvisionedPhone> {
  // Only a teammate's own computer, while its share stands: never a phone asking for another phone.
  const parent = deps.store.lookupDeviceKey(parentDeviceId)
  if (parent.kind !== 'found' || parent.device.parentDeviceId !== undefined) {
    throw new Error('share_phone_refused')
  }
  const { botId, accountId, name } = parent.device
  const shareOf = () =>
    deps
      .bots()
      .find((bot) => bot.id === botId)
      ?.shares?.find((share) => share.kind === 'account' && share.accountId === accountId)
  const share = shareOf()
  if (!share) {
    throw new Error('share_phone_refused')
  }
  const { device, added } = await bindBotShareDevice(deps.store, {
    botId,
    accountId,
    name,
    devicePublicKey: params.devicePublicKey,
    phone: { parentDeviceId, shareId: share.shareId }
  })
  const credential = { botId, shareId: share.shareId, deviceId: device.deviceId }
  if (!(await deps.installCredential(credential, params.credentialHash))) {
    if (added) {
      await deps.store.remove(device.deviceId)
    }
    throw new Error('share_credential_not_installed')
  }
  const offer: BotTeamShareOffer = await inviteBotShareDevice(deps, device)
  // A remove that landed meanwhile found no phone row to end; end the one just made.
  if (shareOf()?.shareId !== share.shareId) {
    await deps.revokeDevices(botId, accountId)
    throw new Error('share_phone_refused')
  }
  return {
    deviceId: device.deviceId,
    sealedOffer: sealBotTeamShareOffer(NODE_PAIRED_E2EE_PRIMITIVES, {
      sealKey: params.sealKey,
      offer
    })
  }
}
