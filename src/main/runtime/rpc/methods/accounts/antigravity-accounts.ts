import { defineMethod, defineStreamingMethod, type RpcContext } from '../../core'
import { rpcCallerOperationKey } from '../../callers/rpc-caller-identity'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import {
  AntigravityAccountMutationParams,
  AntigravityAccountTargetParams,
  AntigravityChatApiKeySaveParams,
  AntigravityChatSignInCompleteParams,
  AntigravityChatSignInFlowParams,
  AntigravityChatSignInStartParams
} from '../../../../../shared/rpc-contract/accounts/antigravity-accounts-params'
import { AntigravityChatAuthConfigSchema } from '../../../../../shared/agent-accounts/antigravity/antigravity-chat-auth-config'
import { getAntigravityAccountService } from '../../../../antigravity/native-account-host'
import { restartIdleAgyChats, withAntigravityChatBackend } from './antigravity-chat-backend'
import { lastAntigravityAgySignedOut } from '../../../../antigravity/antigravity-chat-route'
import { readyAntigravityHostAcpVersion } from '../../../../antigravity/antigravity-host-acp'
import {
  cancelAntigravityChatSignIn,
  completeAntigravityChatSignIn,
  readAntigravityChatSignInStatus,
  startAntigravityChatSignIn,
  subscribeAntigravityChatSignIn
} from '../../../../antigravity/antigravity-chat-sign-in'
import { bindStructuredAgentSessionStream } from '../structured-sessions/subscriptions/structured-agent-session-status-stream'
import {
  resolveHostStructuredAgentLaunchEnvironment,
  structuredAgentHostLaunchSources
} from '../../../agent-session/launch/structured-agent-launch-support'
import {
  countStructuredAgentChats,
  stopStructuredAgentChats
} from '../../../agent-session/lifecycle/structured-agent-chat-stop'

import {
  readAntigravityChatAuthConfig,
  applyAntigravityChatAuthConfig
} from '../../../../antigravity/antigravity-chat-auth-settings'
import {
  clearAntigravityChatApiKey,
  readAntigravityChatApiKeyStatus,
  storeAntigravityChatApiKey
} from '../../../../antigravity/antigravity-chat-api-key'
import { detectAntigravityChatAuth } from '../../../../antigravity/antigravity-chat-auth-detect'
import { seedAntigravityChatAuth } from '../../../../antigravity/antigravity-chat-saved-sign-in'

// Running chats hold the old key until they start again.
const restartLiveChats = (runtime: OrcaRuntimeService): Promise<void> =>
  chatSignInHost(runtime)
    .stopLiveChats()
    .catch((error: unknown) => console.warn('[antigravity] chats kept the previous key:', error))

const chatLaunchEnv = (runtime: OrcaRuntimeService) => () =>
  resolveHostStructuredAgentLaunchEnvironment('antigravity', runtime.requireStore().getSettings())

const apiKeyStatus = (runtime: OrcaRuntimeService) =>
  readAntigravityChatApiKeyStatus(chatLaunchEnv(runtime))

const savedChatMethod = (runtime: OrcaRuntimeService) => () =>
  readAntigravityChatAuthConfig(runtime.requireStore())?.method ?? null

function detectChatAuth(runtime: OrcaRuntimeService) {
  // One environment read serves the key check and the ADC lookup. It serves the shell capture
  // chats launch from, refreshed in the background at most every 10s; it waits only for the
  // first capture after a start, so a GEMINI_API_KEY exported by the profile is seen.
  const env = chatLaunchEnv(runtime)()
  const launchEnv = () => env
  void seedAntigravityChatAuth(savedChatMethod(runtime))
  return detectAntigravityChatAuth({
    config: () => readAntigravityChatAuthConfig(runtime.requireStore()),
    launchEnv,
    apiKeyStatus: () => readAntigravityChatApiKeyStatus(launchEnv),
    liveChats: () => countStructuredAgentChats('antigravity'),
    agyVersion: readyAntigravityHostAcpVersion,
    agySignedOut: lastAntigravityAgySignedOut
  })
}

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
    handler: async (target, ctx) =>
      withAntigravityChatBackend(
        ctx.runtime,
        target,
        await (await getAntigravityAccountService(target)).listAccounts()
      )
  }),
  defineMethod({
    name: 'accounts.antigravityAddCurrent',
    permission: 'accounts-admin',
    params: AntigravityAccountTargetParams,
    handler: async (target, ctx) =>
      withAntigravityChatBackend(
        ctx.runtime,
        target,
        await (await getAntigravityAccountService(target)).addCurrentAccount()
      )
  }),
  defineMethod({
    name: 'accounts.antigravitySelect',
    permission: 'accounts-admin',
    params: AntigravityAccountMutationParams,
    handler: async ({ target, accountId }, ctx) => {
      const state = await (await getAntigravityAccountService(target)).selectAccount(accountId)
      restartIdleAgyChats(target)
      return withAntigravityChatBackend(ctx.runtime, target, state)
    }
  }),
  defineMethod({
    name: 'accounts.antigravityRemove',
    permission: 'accounts-admin',
    params: AntigravityAccountMutationParams,
    handler: async ({ target, accountId }, ctx) =>
      withAntigravityChatBackend(
        ctx.runtime,
        target,
        await (await getAntigravityAccountService(target)).removeAccount(accountId)
      )
  }),
  defineMethod({
    name: 'accounts.antigravityChatSignInStart',
    permission: 'accounts-admin',
    params: AntigravityChatSignInStartParams,
    handler: async ({ intent }, ctx) =>
      startAntigravityChatSignIn(chatSignInHost(ctx.runtime), signInOwner(ctx), intent)
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
      // After a restart, a saved Google sign-in reads as signed in without starting the server.
      void seedAntigravityChatAuth(savedChatMethod(ctx.runtime))
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
  }),
  defineMethod({
    name: 'accounts.antigravityChatApiKeyStatus',
    permission: 'accounts-admin',
    params: null,
    handler: (_, ctx) => apiKeyStatus(ctx.runtime)
  }),
  defineMethod({
    name: 'accounts.antigravityChatAuthDetect',
    permission: 'accounts-admin',
    params: null,
    handler: (_, ctx) => detectChatAuth(ctx.runtime)
  }),
  defineMethod({
    name: 'accounts.antigravityChatApiKeySave',
    permission: 'accounts-admin',
    params: AntigravityChatApiKeySaveParams,
    handler: async ({ apiKey }, ctx) => {
      await storeAntigravityChatApiKey(apiKey)
      await restartLiveChats(ctx.runtime)
      return apiKeyStatus(ctx.runtime)
    }
  }),
  defineMethod({
    name: 'accounts.antigravityChatApiKeyClear',
    permission: 'accounts-admin',
    params: null,
    handler: async (_, ctx) => {
      await clearAntigravityChatApiKey()
      await restartLiveChats(ctx.runtime)
      return apiKeyStatus(ctx.runtime)
    }
  })
] as const
