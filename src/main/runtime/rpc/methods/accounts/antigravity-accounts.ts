import { defineMethod } from '../../core'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import {
  AntigravityAccountMutationParams,
  AntigravityAccountTargetParams,
  AntigravityChatApiKeySaveParams
} from '../../../../../shared/rpc-contract/accounts/antigravity-accounts-params'
import { AntigravityChatAuthConfigSchema } from '../../../../../shared/agent-accounts/antigravity/antigravity-chat-auth-config'
import { getAntigravityAccountService } from '../../../../antigravity/native-account-host'
import { restartIdleAgyChats, withAntigravityChatBackend } from './antigravity-chat-backend'
import { syncAgyLoginCopy } from '../../../../antigravity/antigravity-chat-agy-login-copy'
import { getProfileUserDataPath } from '../../../../orca-profiles/profile-storage-paths'
import { lastAntigravityAgySignedOut } from '../../../../antigravity/antigravity-chat-route'
import { readyAntigravityHostAcpVersion } from '../../../../antigravity/antigravity-host-acp'
import { resolveHostStructuredAgentLaunchEnvironment } from '../../../agent-session/launch/structured-agent-launch-support'
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

const stopLiveChats = () => stopStructuredAgentChats('antigravity', 'Antigravity')

// Running chats hold the old key until they start again.
const restartLiveChats = (): Promise<void> =>
  stopLiveChats().catch((error: unknown) =>
    console.warn('[antigravity] chats kept the previous key:', error)
  )

const chatLaunchEnv = (runtime: OrcaRuntimeService) => () =>
  resolveHostStructuredAgentLaunchEnvironment('antigravity', runtime.requireStore().getSettings())

const apiKeyStatus = (runtime: OrcaRuntimeService) =>
  readAntigravityChatApiKeyStatus(chatLaunchEnv(runtime))

function detectChatAuth(runtime: OrcaRuntimeService) {
  // One environment read serves the key check and the ADC lookup. It serves the shell capture
  // chats launch from, refreshed in the background at most every 10s; it waits only for the
  // first capture after a start, so a GEMINI_API_KEY exported by the profile is seen.
  const env = chatLaunchEnv(runtime)()
  const launchEnv = () => env
  return detectAntigravityChatAuth({
    config: () => readAntigravityChatAuthConfig(runtime.requireStore()),
    launchEnv,
    apiKeyStatus: () => readAntigravityChatApiKeyStatus(launchEnv),
    liveChats: () => countStructuredAgentChats('antigravity'),
    agyVersion: readyAntigravityHostAcpVersion,
    agySignedOut: lastAntigravityAgySignedOut
  })
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
      restartIdleAgyChats(target, ctx.runtime)
      return withAntigravityChatBackend(ctx.runtime, target, state)
    }
  }),
  defineMethod({
    name: 'accounts.antigravityRemove',
    permission: 'accounts-admin',
    params: AntigravityAccountMutationParams,
    handler: async ({ target, accountId }, ctx) => {
      const state = await (await getAntigravityAccountService(target)).removeAccount(accountId)
      // Removing the signed-in account signs agy out; chats holding it start again without it.
      restartIdleAgyChats(target, ctx.runtime)
      return withAntigravityChatBackend(ctx.runtime, target, state)
    }
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
    handler: async (config, ctx) => {
      const store = ctx.runtime.requireStore()
      const applied = await applyAntigravityChatAuthConfig(store, config, stopLiveChats)
      // A key or gcloud mustn't find the Google login in Orca's chat home; Google brings it back.
      await syncAgyLoginCopy(applied, getProfileUserDataPath())
      return applied
    }
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
      await restartLiveChats()
      return apiKeyStatus(ctx.runtime)
    }
  }),
  defineMethod({
    name: 'accounts.antigravityChatApiKeyClear',
    permission: 'accounts-admin',
    params: null,
    handler: async (_, ctx) => {
      await clearAntigravityChatApiKey()
      await restartLiveChats()
      return apiKeyStatus(ctx.runtime)
    }
  })
] as const
