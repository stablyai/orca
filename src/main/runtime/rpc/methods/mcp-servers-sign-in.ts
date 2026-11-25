// mcpServers.signIn.* and signOut: Orca's own sign-in to a server in the host's list, run on the
// host for the device that asks; only that device may wait on, finish or cancel it.
import type { BotToolSignInAttemptView } from '../../../../shared/bot-tool-sign-in'
import {
  McpServerSignInFinish,
  McpServerSignInFlow,
  McpServerSignInStart,
  McpServerSignInWait,
  McpServerTarget
} from '../../../../shared/rpc-contract/mcp-servers-params'
import {
  cancelBotToolSignInAttempt,
  finishBotToolSignInAttempt,
  startBotToolSignInAttempt,
  waitBotToolSignInAttempt
} from '../../../bots/tool-oauth/bot-tool-sign-in-attempts'
import {
  mcpServerSignInKey,
  noSignIn,
  signOutMcpServer
} from '../../../mcp-servers/mcp-host-list-sign-in'
import { rpcCallerOperationKey } from '../callers/rpc-caller-identity'
import { defineMethod, type RpcContext } from '../core'
import { inHostWords } from './bots-tools-owned-sign-in'
import { changed, onHost } from './mcp-servers'

/** The device asking, by the identity its connection proved; only it may wait on, finish or cancel. */
function signInOwner(context: RpcContext): string {
  if (!context.caller) {
    throw new Error('This client can’t sign in to servers on this computer.')
  }
  return rpcCallerOperationKey(context.caller)
}

export const MCP_SERVER_SIGN_IN_METHODS = [
  defineMethod({
    name: 'mcpServers.signIn.start',
    permission: 'workspace',
    params: McpServerSignInStart,
    handler: (params, context): Promise<BotToolSignInAttemptView> =>
      onHost(context, async () => {
        const owner = signInOwner(context)
        const key = await mcpServerSignInKey(params.id)
        if (!key) {
          throw noSignIn()
        }
        return inHostWords(() => startBotToolSignInAttempt(owner, key, params.mode))
      })
  }),
  defineMethod({
    name: 'mcpServers.signOut',
    permission: 'workspace',
    params: McpServerTarget,
    handler: (params, context) =>
      onHost(context, async () => changed(await signOutMcpServer(params.id)), true)
  }),
  defineMethod({
    name: 'mcpServers.signIn.wait',
    permission: 'workspace',
    params: McpServerSignInWait,
    handler: (params, context) =>
      onHost(context, () =>
        waitBotToolSignInAttempt(
          signInOwner(context),
          params.flowId,
          params.afterRevision,
          context.signal
        )
      )
  }),
  defineMethod({
    name: 'mcpServers.signIn.finish',
    permission: 'workspace',
    params: McpServerSignInFinish,
    handler: (params, context) =>
      onHost(context, async () => {
        const owner = signInOwner(context)
        return inHostWords(() => finishBotToolSignInAttempt(owner, params.flowId, params.query))
      })
  }),
  defineMethod({
    name: 'mcpServers.signIn.cancel',
    permission: 'workspace',
    params: McpServerSignInFlow,
    handler: (params, context) =>
      onHost(context, async () => cancelBotToolSignInAttempt(signInOwner(context), params.flowId))
  })
]
