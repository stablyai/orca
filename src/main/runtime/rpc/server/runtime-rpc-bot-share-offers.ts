// Teammates' devices for the bots this host shares: a device's offer after its accept, and a key for a
// teammate's phone that their computer asks for.
import {
  mintBotShareOffer,
  type BotShareOfferAsk,
  type BotShareOfferDeps
} from './pairing/bot-share-offer'
import { provisionBotSharePhone } from './pairing/bot-share-phone'
import type {
  BotShareProvisionedPhone,
  BotShareProvisionPhoneParams
} from '../../../../shared/bots/bot-share-phone'
import type { BotTeamShareOffer } from '../../../../shared/bots/bot-team-share-seal'
import { installBotSharePhoneCredential } from '../../../bots/team-share/bot-share-phone-credentials'
import { RuntimeRpcPairing } from './runtime-rpc-pairing'

export class RuntimeRpcBotShareOffers extends RuntimeRpcPairing {
  /** A teammate's device asked to reach a shared bot: see `mintBotShareOffer`. */
  async mintBotShareOffer(ask: BotShareOfferAsk): Promise<BotTeamShareOffer> {
    return await mintBotShareOffer(this.botShareOfferDeps(), ask)
  }

  /** A teammate's computer asked for its phone's key: see `provisionBotSharePhone`. */
  async provisionBotSharePhone(
    parentDeviceId: string,
    params: BotShareProvisionPhoneParams
  ): Promise<BotShareProvisionedPhone> {
    return await provisionBotSharePhone(
      {
        ...this.botShareOfferDeps(),
        bots: () => this.runtime.bots.list(),
        installCredential: (phone, hash) =>
          installBotSharePhoneCredential(this.runtime.getConnectorCloud(), phone, hash),
        revokeDevices: (botId, accountId) => this.revokeBotShareDevices(botId, accountId)
      },
      parentDeviceId,
      params
    )
  }

  private botShareOfferDeps(): BotShareOfferDeps {
    const store = this.botShareDevices
    const relay = this.mobileRelayPairingProvider
    const hostPublicKeyB64 = this.e2eeKeypair?.publicKeyB64
    if (!store || !relay || !hostPublicKeyB64) {
      throw new Error('share_offer_unavailable')
    }
    return {
      store,
      relay,
      hostPublicKeyB64,
      bindRelay: (deviceId, binding) => this.setRelayDeviceBinding(deviceId, binding),
      revokeRelay: (binding) => {
        this.queueRelayDeviceRevoke(binding)
      }
    }
  }
}
