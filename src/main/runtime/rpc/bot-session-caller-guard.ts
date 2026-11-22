import {
  BOT_TOKEN_ENDED,
  botOfCaller,
  botOfToken,
  type BotCallerRuntime
} from '../../bots/bot-of-caller'
import { botToolRelay, type BotToolRelay } from '../../bots/tool-relay/bot-tool-relay'
import type { OrchestrationEntryCaller } from '../orchestration/addressing/orchestration-caller-identity'
import { InvalidArgumentError, type RpcContext, type RpcRequest } from './core'

export const BOT_SESSION_NEEDS_TOKEN =
  'Only the bot’s own run can act as its chat. Run this from that chat, which holds the bot’s Orca token.'

/** A local CLI call naming a bot's chat or look-around run as its caller must carry that bot's token:
 *  any run can set a session id, only the bot's own runs get its token (bot-tools-file.ts). */
export function assertBotSessionCallerHoldsToken(
  // Runtime test fakes may omit bots and the look-around store.
  runtime: Partial<BotCallerRuntime>,
  request: Pick<RpcRequest, 'botToken' | 'orchestrationCompatibilityEvidence'>,
  context: Pick<RpcContext, 'caller' | 'pairedDeviceId'>,
  sessionCaller: OrchestrationEntryCaller | undefined,
  params: unknown,
  relay: Pick<BotToolRelay, 'botOf'> = botToolRelay
): void {
  const { bots, lookAround } = runtime
  if (context.caller?.kind !== 'local-cli' || !bots || !lookAround) {
    return
  }
  const token = botTokenOf(request, params)
  for (const claimed of claimedSessionIds(request, sessionCaller, params)) {
    const bot = botOfCaller({ bots, lookAround }, claimed, context.pairedDeviceId)
    if (!bot) {
      continue
    }
    const holder = botOfToken({ bots }, token, context.pairedDeviceId, relay)
    if (holder.kind === 'bot' && holder.bot.id === bot.id) {
      continue
    }
    throw new InvalidArgumentError(
      holder.kind === 'ended' ? BOT_TOKEN_ENDED : BOT_SESSION_NEEDS_TOKEN
    )
  }
}

/** The envelope's token, or the one Google commands carry in their params. */
function botTokenOf(request: Pick<RpcRequest, 'botToken'>, params: unknown): string | undefined {
  const carried =
    request.botToken ??
    (typeof params === 'object' && params !== null && 'botToken' in params
      ? params.botToken
      : undefined)
  return typeof carried === 'string' && carried ? carried : undefined
}

function claimedSessionIds(
  request: Pick<RpcRequest, 'orchestrationCompatibilityEvidence'>,
  sessionCaller: OrchestrationEntryCaller | undefined,
  params: unknown
): Set<string> {
  const ids = new Set<string>()
  const add = (id: unknown): void => {
    if (typeof id === 'string' && id) {
      ids.add(id)
    }
  }
  add(request.orchestrationCompatibilityEvidence?.agentSessionId)
  if (sessionCaller && sessionCaller.kind === undefined) {
    add(sessionCaller.sessionId)
  }
  if (typeof params === 'object' && params !== null) {
    add('callerSessionId' in params ? params.callerSessionId : undefined)
    add('callerAgentSessionId' in params ? params.callerAgentSessionId : undefined)
  }
  return ids
}
