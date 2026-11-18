import { BotAccessDecide, BotAccessRedeem } from '../../../../shared/rpc-contract/bots-params'
import {
  BOT_ACCESS_HOST_ERRORS,
  botAccessHost as accessHost,
  decideHostAccessRequest,
  listHostAccessRequests,
  redeemHostAccessRequest
} from '../../../bots/bot-access-host'
import { defineMethod } from '../core'

// Requests to be let onto a bot's Who can ask list.
export const BOT_ACCESS_METHODS = [
  // Answered as this host's Orca account; any paired client may, behind its own confirm (decision D3).
  defineMethod({
    name: 'bots.access.list',
    permission: 'workspace',
    params: null,
    // From the host's store, so every window's and phone's re-read on botsChanged costs no cloud call.
    handler: async (_params, { runtime }) =>
      runtime.botAccessWatch?.list() ?? listHostAccessRequests(accessHost(runtime))
  }),
  defineMethod({
    name: 'bots.access.decide',
    permission: 'workspace',
    params: BotAccessDecide,
    handler: async (params, { runtime, pairedDeviceId }) => {
      const result = await decideHostAccessRequest(
        accessHost(runtime),
        params,
        pairedDeviceId ?? null
      )
      // The answered request leaves every window's and phone's list now, not on the next tick.
      if (result.ok || result.error === BOT_ACCESS_HOST_ERRORS.notWaiting) {
        void runtime.botAccessWatch?.answered(params.requestId)
      }
      return result
    }
  }),
  defineMethod({
    name: 'bots.access.redeem',
    permission: 'workspace',
    params: BotAccessRedeem,
    handler: async (params, { runtime }) => redeemHostAccessRequest(accessHost(runtime), params)
  })
]
