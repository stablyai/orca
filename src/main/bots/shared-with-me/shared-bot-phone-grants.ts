// This computer's phones and the agents shared with its account: a phone asks here for its own key to
// one, which this computer asks the agent's host for over its own link. A phone unpaired here loses
// those keys: each is ended on its host, retried until the host has.
import {
  BOT_SHARE_PROVISION_PHONE_METHOD,
  BOT_SHARE_REVOKE_PHONE_METHOD,
  BotShareProvisionedPhone,
  SHARED_BOTS_PHONE_ERRORS,
  type SharedBotPhoneGrant,
  type SharedBotsPhoneList,
  type SharedBotsPhoneProvisionParams
} from '../../../shared/bots/bot-share-phone'
import type { RpcResponse } from '../../../shared/remote-runtime/rpc/rpc-response-shape'
import {
  sharedBotHostKey,
  type SharedBotHostEntry,
  type SharedBotHostStore
} from './shared-bot-host-store'
import type { SharedBotLink } from './shared-bot-pairing'

export type SharedBotPhoneGrantsDeps = {
  /** Loaded: every call here comes once the kept shares are (`sharedHostPhoneGrants`). */
  store: SharedBotHostStore
  /** The kept shares the cloud still lists. */
  listed: () => readonly SharedBotHostEntry[]
  /** The entry's link once any dial it can make has settled. */
  reach: (entry: SharedBotHostEntry) => Promise<SharedBotLink>
  request: (entry: SharedBotHostEntry, method: string, params: unknown) => Promise<RpcResponse>
  /** Orca Cloud's connector origin, which the phone holds messages at; null without a cloud. */
  origin: () => string | null
}

export class SharedBotPhoneGrants {
  constructor(private readonly deps: SharedBotPhoneGrantsDeps) {}

  /** The shared agents this computer has reached, which a phone can get a key to. */
  phoneShares(): SharedBotsPhoneList {
    return {
      shares: this.paired().map((entry) => ({
        shareId: entry.shareId,
        botId: entry.botId,
        botName: entry.botName,
        ownerName: entry.ownerName
      }))
    }
  }

  /** Asks the host for the phone's key and answers with its grant; a key this phone had before on
   *  that host is ended there. */
  async provisionPhone(
    phoneDeviceId: string,
    params: SharedBotsPhoneProvisionParams
  ): Promise<SharedBotPhoneGrant> {
    const entry = this.paired().find((candidate) => candidate.shareId === params.shareId)
    const hostKey = entry && sharedBotHostKey(entry)
    const origin = this.deps.origin()
    if (!entry || !hostKey || !origin) {
      throw new Error(SHARED_BOTS_PHONE_ERRORS.unknownShare)
    }
    if ((await this.deps.reach(entry)) !== 'live') {
      throw new Error(SHARED_BOTS_PHONE_ERRORS.hostOffline)
    }
    const response = await this.deps
      .request(entry, BOT_SHARE_PROVISION_PHONE_METHOD, {
        devicePublicKey: params.devicePublicKey,
        sealKey: params.sealKey,
        credentialHash: params.credentialHash
      })
      .catch(() => null)
    const provisioned = response?.ok
      ? BotShareProvisionedPhone.safeParse(response.result).data
      : undefined
    if (!provisioned) {
      throw new Error(SHARED_BOTS_PHONE_ERRORS.refused)
    }
    const current = this.deps.store.get(entry.shareId) ?? entry
    this.deps.store.put({
      ...current,
      phones: [
        ...current.phones.map((phone) =>
          phone.phoneDeviceId === phoneDeviceId && phone.hostDeviceId !== provisioned.deviceId
            ? { ...phone, removed: true as const }
            : phone
        ),
        ...(current.phones.some((phone) => phone.hostDeviceId === provisioned.deviceId)
          ? []
          : [{ phoneDeviceId, hostDeviceId: provisioned.deviceId }])
      ]
    })
    void this.endRemoved(entry.shareId)
    return {
      v: 1,
      shareId: entry.shareId,
      botId: entry.botId,
      botName: entry.botName,
      ownerName: entry.ownerName,
      connectorOrigin: origin,
      hostKey,
      sealedOffer: provisioned.sealedOffer
    }
  }

  /** The phone was unpaired from this computer: its keys to shared agents end on their hosts. */
  async forgetPhone(phoneDeviceId: string): Promise<void> {
    const holding = this.deps.store
      .list()
      .filter((entry) =>
        entry.phones.some((phone) => phone.phoneDeviceId === phoneDeviceId && !phone.removed)
      )
    for (const entry of holding) {
      this.deps.store.put({
        ...entry,
        phones: entry.phones.map((phone) =>
          phone.phoneDeviceId === phoneDeviceId ? { ...phone, removed: true as const } : phone
        )
      })
    }
    await Promise.all(holding.map((entry) => this.endRemoved(entry.shareId)))
  }

  /** Ends each removed phone's key on the share's host while it is reached; kept for the next try. */
  async endRemoved(shareId: string): Promise<void> {
    const entry = this.deps.store.get(shareId)
    const removed = entry?.phones.filter((phone) => phone.removed) ?? []
    if (!entry || removed.length === 0 || (await this.deps.reach(entry)) !== 'live') {
      return
    }
    for (const phone of removed) {
      const ended = await this.deps
        .request(entry, BOT_SHARE_REVOKE_PHONE_METHOD, { deviceId: phone.hostDeviceId })
        .catch(() => null)
      const current = this.deps.store.get(shareId)
      if (ended?.ok && current) {
        this.deps.store.put({
          ...current,
          phones: current.phones.filter((kept) => kept.hostDeviceId !== phone.hostDeviceId)
        })
      }
    }
  }

  private paired(): SharedBotHostEntry[] {
    return this.deps.listed().filter((entry) => entry.offer !== undefined)
  }
}
