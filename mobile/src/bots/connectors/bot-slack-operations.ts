// A bot's Slack on its host, all on the phone's bot allowlist; the host answers each as BotSlackResult.
import * as z from 'zod'
import {
  BOT_SLACK_DESKTOP_ERRORS,
  ConnectorBotSlackAppResponse,
  ConnectorBotSlackStateResponse,
  ConnectorSlackGrantResponse
} from '../../../../src/shared/connector-bot-slack-contract'
import { isHostNotConnectedError } from '../../query/host-query-errors'
import type { RpcResponse } from '../../transport/rpc/rpc-wire-types'
import { bindDeferredRpcOperation, defineRpcOperation } from '../../transport/rpc/rpc-operation'
import { rpcResultVariant } from '../../transport/rpc/rpc-operation-result-reader'

const hostRefusal = z.looseObject({ ok: z.literal(false), error: z.string() })

export const slackStateRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'bots.slack.state',
    method: 'bots.slack.state',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant(
      'bot-slack-state',
      z.union([
        z.looseObject({ ok: z.literal(true), value: ConnectorBotSlackStateResponse }),
        hostRefusal
      ])
    )
  })
)

function slackWrite<
  Method extends 'bots.slack.saveGrant' | 'bots.slack.setUpApp' | 'bots.slack.remove',
  Value extends z.ZodType
>(method: Method, value: Value) {
  return bindDeferredRpcOperation(
    defineRpcOperation({
      name: method,
      method,
      acceptance: 'require-result-or-throw-message',
      barrier: 'after-caller-barrier',
      read: rpcResultVariant(
        method,
        z.union([z.looseObject({ ok: z.literal(true), value }), hostRefusal])
      )
    })
  )
}

export const slackSaveGrant = slackWrite('bots.slack.saveGrant', ConnectorSlackGrantResponse)
export const slackSetUpApp = slackWrite('bots.slack.setUpApp', ConnectorBotSlackAppResponse)
// The host's success carries no value, which JSON drops.
export const slackRemove = slackWrite('bots.slack.remove', z.unknown().optional())

/** One Slack write: the host's answer, or its error code; a host that can't be reached says so. */
export async function slackCall<Answer extends { ok: true } | { ok: false; error: string }>(
  send: () => Promise<RpcResponse>,
  interpret: (reply: RpcResponse) => Answer
): Promise<Answer | { ok: false; error: string }> {
  try {
    return interpret(await send())
  } catch (error) {
    return {
      ok: false,
      error: isHostNotConnectedError(error) ? HOST_OFFLINE : BOT_SLACK_DESKTOP_ERRORS.failed
    }
  }
}

/** The phone's own code for a host it can't reach. */
export const HOST_OFFLINE = 'host_offline'
