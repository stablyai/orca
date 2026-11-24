// bots.tools.signIn.*: Orca's own sign-in to a bot's app, run on the bot's host for the device that
// asks. The app returns to this host's listener (a routed page) or the device pastes the returned
// query; only that device may wait on, finish or cancel it, and the bot itself never signs in.
import type { BotToolSignInAttemptView } from '../../../../shared/bot-tool-sign-in'
import {
  BotToolSignInFinish,
  BotToolSignInFlow,
  BotToolSignInStart,
  BotToolSignInWait
} from '../../../../shared/rpc-contract/bots-tools-params'
import { botHomeFolder } from '../../../bots/bot-home'
import { botOfCaller } from '../../../bots/bot-of-caller'
import { BotToolSignInError } from '../../../bots/tool-oauth/bot-tool-oauth'
import {
  botToolSignInMessage,
  ownedSignInKey
} from '../../../bots/tool-oauth/bot-tool-owned-sign-in'
import {
  cancelBotToolSignInAttempt,
  finishBotToolSignInAttempt,
  startBotToolSignInAttempt,
  waitBotToolSignInAttempt
} from '../../../bots/tool-oauth/bot-tool-sign-in-attempts'
import { defineMethod, InvalidArgumentError, type RpcContext } from '../core'
import { rpcCallerOperationKey } from '../callers/rpc-caller-identity'
import { targetBot } from './bots-tools-target'

/** The device asking, by the identity its connection proved; the bot's own chat and runs are refused. */
function signInOwner(callerSessionId: string | undefined, context: RpcContext): string {
  context.runtime.bots.assertEnabled()
  if (botOfCaller(context.runtime, callerSessionId, context.pairedDeviceId)) {
    throw new InvalidArgumentError('A bot can’t sign itself in to apps. Sign in from Orca.')
  }
  if (!context.caller) {
    throw new Error('This client can’t sign in to apps on this computer.')
  }
  return rpcCallerOperationKey(context.caller)
}

/** Fixed copy for a sign-in failure; never provider text. */
async function inHostWords<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    throw error instanceof BotToolSignInError ? new Error(botToolSignInMessage(error.code)) : error
  }
}

export const BOT_TOOLS_OWNED_SIGN_IN_METHODS = [
  defineMethod({
    name: 'bots.tools.signIn.start',
    permission: 'workspace',
    params: BotToolSignInStart,
    handler: async (params, context): Promise<BotToolSignInAttemptView> => {
      const owner = signInOwner(params.callerSessionId, context)
      const folder = botHomeFolder(targetBot(params, context))
      const key = await ownedSignInKey(folder, params.name)
      if (!key) {
        throw new InvalidArgumentError('Orca doesn’t sign in to this tool.')
      }
      return inHostWords(() => startBotToolSignInAttempt(owner, key, params.mode))
    }
  }),
  defineMethod({
    name: 'bots.tools.signIn.wait',
    permission: 'workspace',
    params: BotToolSignInWait,
    handler: (params, context) =>
      waitBotToolSignInAttempt(
        signInOwner(params.callerSessionId, context),
        params.flowId,
        params.afterRevision,
        context.signal
      )
  }),
  defineMethod({
    name: 'bots.tools.signIn.finish',
    permission: 'workspace',
    params: BotToolSignInFinish,
    handler: (params, context) => {
      const owner = signInOwner(params.callerSessionId, context)
      return inHostWords(() => finishBotToolSignInAttempt(owner, params.flowId, params.query))
    }
  }),
  defineMethod({
    name: 'bots.tools.signIn.cancel',
    permission: 'workspace',
    params: BotToolSignInFlow,
    handler: (params, context) =>
      cancelBotToolSignInAttempt(signInOwner(params.callerSessionId, context), params.flowId)
  })
]
