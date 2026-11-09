import { defineMethod, defineStreamingMethod, type RpcContext } from '../../core'
import { rpcCallerOperationKey } from '../../rpc-caller-identity'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import {
  AntigravityAccountMutationParams,
  AntigravityAccountTargetParams,
  AntigravityChatSignInCompleteParams,
  AntigravityChatSignInFlowParams
} from '../../../../../shared/rpc-contract/antigravity-accounts-params'
import { AntigravityChatAuthConfigSchema } from '../../../../../shared/antigravity-chat-auth-config'
import { getAntigravityAccountService } from '../../../../antigravity/native-account-host'
import {
  cancelAntigravityChatSignIn,
  completeAntigravityChatSignIn,
  readAntigravityChatSignInStatus,
  startAntigravityChatSignIn,
  subscribeAntigravityChatSignIn
} from '../../../../antigravity/antigravity-chat-sign-in'
import { bindStructuredAgentSessionStream } from '../structured-sessions/subscriptions/structured-agent-session-status-stream'
import { structuredAgentHostLaunchSources } from '../../../agent-session/launch/structured-agent-launch-support'
import { stopStructuredAgentChats } from '../../../agent-session/lifecycle/structured-agent-chat-stop'

import {
  readAntigravityChatAuthConfig,
  applyAntigravityChatAuthConfig
} from '../../../../antigravity/antigravity-chat-auth-settings'

const chatSignInHost = (runtime: OrcaRuntimeService) => ({
  launchSources: (signal: AbortSignal) =>
    structuredAgentHostLaunchSources('antigravity', runtime, signal),
  stopLiveChats: () => stopStructuredAgentChats('antigravity', 'Antigravity')
})

/** The caller a sign-in belongs to, as its transport proved it; one it can't name gets none. */
function signInOwner({ caller }: Pick<RpcContext, 'caller'>): string {
  if (!caller) {
    throw new Error('This client cannot sign Antigravity in.')
  }
  return rpcCallerOperationKey(caller)
}

export const ANTIGRAVITY_ACCOUNT_METHODS = [
  defineMethod({
    name: 'accounts.antigravityList',
    permission: 'workspace',
    params: AntigravityAccountTargetParams,
    handler: async (target) => (await getAntigravityAccountService(target)).listAccounts()
  }),
  defineMethod({
    name: 'accounts.antigravityAddCurrent',
    permission: 'accounts-admin',
    params: AntigravityAccountTargetParams,
    handler: async (target) => (await getAntigravityAccountService(target)).addCurrentAccount()
  }),
  defineMethod({
    name: 'accounts.antigravitySelect',
    permission: 'accounts-admin',
    params: AntigravityAccountMutationParams,
    handler: async ({ target, accountId }) =>
      (await getAntigravityAccountService(target)).selectAccount(accountId)
  }),
  defineMethod({
    name: 'accounts.antigravityRemove',
    permission: 'accounts-admin',
    params: AntigravityAccountMutationParams,
    handler: async ({ target, accountId }) =>
      (await getAntigravityAccountService(target)).removeAccount(accountId)
  }),
  defineMethod({
    name: 'accounts.antigravityChatSignInStart',
    permission: 'accounts-admin',
    params: null,
    handler: async (_, ctx) =>
      startAntigravityChatSignIn(chatSignInHost(ctx.runtime), signInOwner(ctx))
  }),
  defineStreamingMethod({
    name: 'accounts.antigravityChatSignInSubscribe',
    permission: 'accounts-admin',
    params: null,
    handler: async (_, ctx, emit) => {
      // A caller with no identity owns no flow, so it sees every flow as another client's.
      const owner = ctx.caller ? rpcCallerOperationKey(ctx.caller) : ''
      const frame = ctx.requestId ? `:${ctx.requestId}` : ''
      const subscriptionId = `antigravityChatSignIn:${ctx.connectionId ?? 'local'}${frame}`
      let dispose = (): void => {}
      const stream = bindStructuredAgentSessionStream(ctx, subscriptionId, () => dispose())
      if (stream.isClosed()) {
        return
      }
      dispose = subscribeAntigravityChatSignIn(() => emit(readAntigravityChatSignInStatus(owner)))
      emit(readAntigravityChatSignInStatus(owner))
    }
  }),
  defineMethod({
    name: 'accounts.antigravityChatSignInCancel',
    permission: 'accounts-admin',
    params: AntigravityChatSignInFlowParams,
    handler: async ({ flowId }, ctx) => cancelAntigravityChatSignIn(signInOwner(ctx), flowId)
  }),
  defineMethod({
    name: 'accounts.antigravityChatSignInComplete',
    permission: 'accounts-admin',
    params: AntigravityChatSignInCompleteParams,
    handler: async ({ flowId, callbackUrl }, ctx) =>
      completeAntigravityChatSignIn(signInOwner(ctx), flowId, callbackUrl)
  }),
  defineMethod({
    name: 'accounts.antigravityChatAuthGet',
    permission: 'accounts-admin',
    params: null,
    handler: (_, ctx) => readAntigravityChatAuthConfig(ctx.runtime.requireStore())
  }),
  defineMethod({
    name: 'accounts.antigravityChatAuthApply',
    permission: 'accounts-admin',
    params: AntigravityChatAuthConfigSchema,
    handler: (config, ctx) =>
      applyAntigravityChatAuthConfig(
        ctx.runtime.requireStore(),
        config,
        chatSignInHost(ctx.runtime).stopLiveChats
      )
  })
] as const
