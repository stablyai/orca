// A teammate's phone and a shared agent. On the agent's host: the teammate's computer asks for its
// phone's key and ends it. On the teammate's computer: its own phone lists the agents shared with this
// account and asks for its grant to one.
import {
  BOT_SHARE_PROVISION_PHONE_METHOD,
  BOT_SHARE_REVOKE_PHONE_METHOD,
  BotShareProvisionPhoneParams,
  BotShareRevokePhoneParams,
  SHARED_BOTS_PHONE_ACCEPT_METHOD,
  SHARED_BOTS_PHONE_DECLINE_METHOD,
  SHARED_BOTS_PHONE_LIST_METHOD,
  SharedBotsPhoneAnswerParams,
  SHARED_BOTS_PHONE_PROVISION_METHOD,
  SHARED_BOTS_PHONE_ERRORS,
  SharedBotsPhoneProvisionParams
} from '../../../../shared/bots/bot-share-phone'
import { sharedHostPhoneGrants } from '../../../ipc/runtime-environments/requests/runtime-environment-shared-hosts'
import { defineMethod, type RpcContext } from '../core'
import { SHARE_SELF } from '../../../../shared/bots/bot-share-rpc-methods'

/** The calling teammate computer's share device: refused to a phone's own key and to anyone else. */
function shareComputer(context: RpcContext): string {
  if (
    context.callerScope?.kind !== 'bot-share' ||
    !context.pairedDeviceId ||
    context.pairedDeviceParentId !== undefined
  ) {
    throw new Error('share_phone_refused')
  }
  return context.pairedDeviceId
}

/** The calling phone, paired to this computer itself (not through another computer). */
function ownPhone(context: RpcContext): string {
  if (
    context.callerScope?.kind !== 'mobile' ||
    context.callerScope.delegated ||
    !context.pairedDeviceId
  ) {
    throw new Error(SHARED_BOTS_PHONE_ERRORS.refused)
  }
  return context.pairedDeviceId
}

async function grants() {
  const phones = await sharedHostPhoneGrants()
  if (!phones) {
    throw new Error(SHARED_BOTS_PHONE_ERRORS.unknownShare)
  }
  return phones
}

export const BOT_SHARE_PHONE_METHODS = [
  defineMethod({
    name: BOT_SHARE_PROVISION_PHONE_METHOD,
    // Reached only through the share allowlist; never granted to a paired client.
    permission: 'pairing-admin',
    share: SHARE_SELF,
    params: BotShareProvisionPhoneParams,
    handler: async (params, context) => {
      const devices = context.runtime.botShareDevices
      if (!devices) {
        throw new Error('share_phone_refused')
      }
      return await devices.provisionBotSharePhone(shareComputer(context), params)
    }
  }),
  defineMethod({
    name: BOT_SHARE_REVOKE_PHONE_METHOD,
    permission: 'pairing-admin',
    share: SHARE_SELF,
    params: BotShareRevokePhoneParams,
    handler: async ({ deviceId }, context) => {
      const revoked =
        (await context.runtime.botShareDevices?.revokeBotSharePhone(
          shareComputer(context),
          deviceId
        )) ?? false
      return { revoked }
    }
  }),
  defineMethod({
    name: SHARED_BOTS_PHONE_LIST_METHOD,
    permission: 'pairing-admin',
    share: 'not-shared',
    params: null,
    handler: async (_params, context) => {
      ownPhone(context)
      return (await grants()).phoneShares()
    }
  }),
  ...([true, false] as const).map((accept) =>
    defineMethod({
      name: accept ? SHARED_BOTS_PHONE_ACCEPT_METHOD : SHARED_BOTS_PHONE_DECLINE_METHOD,
      permission: 'pairing-admin',
      share: 'not-shared',
      params: SharedBotsPhoneAnswerParams,
      handler: async ({ shareId }, context) => {
        ownPhone(context)
        return { answered: await (await grants()).answer(shareId, accept) }
      }
    })
  ),
  defineMethod({
    name: SHARED_BOTS_PHONE_PROVISION_METHOD,
    permission: 'pairing-admin',
    share: 'not-shared',
    params: SharedBotsPhoneProvisionParams,
    handler: async (params, context) =>
      await (await grants()).provisionPhone(ownPhone(context), params)
  })
]
