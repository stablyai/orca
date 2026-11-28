import { isAbsolute } from 'node:path'
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
import {
  readAgySignInInBackground,
  restartIdleAgyChats,
  withAntigravityChatBackend
} from './antigravity-chat-backend'
import {
  lastAntigravityAgySignedOut,
  onAntigravityChatApiKeyChanged,
  savedChatAuthUsesGeminiApiKey
} from '../../../../antigravity/antigravity-chat-route'
import { readyAntigravityHostAcpVersion } from '../../../../antigravity/antigravity-host-acp'
import {
  antigravitySignInHoldsNativeLogin,
  cancelAntigravityChatSignIn,
  completeAntigravityChatSignIn,
  readAntigravityChatSignInStatus,
  startAntigravityChatSignIn,
  subscribeAntigravityChatSignIn
} from '../../../../antigravity/antigravity-chat-sign-in'
import { forgetAgyLogin } from './agy-login-change'
import { AGY_HOST_SELECTION } from '../../../../antigravity/agy-account-selection'
import { bindStructuredAgentSessionStream } from '../structured-sessions/subscriptions/structured-agent-session-status-stream'
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
import { acpHostBackendInput } from '../../../../acp/launch/acp-launch-command'
import { ANTIGRAVITY_LAUNCH_SPEC } from '../../../../antigravity/antigravity-acp-launch-spec'
import { getProfileUserDataPath } from '../../../../orca-profiles/profile-storage-paths'
import type { AntigravityChatSignInHost } from '../../../../antigravity/antigravity-chat-sign-in'

const stopLiveChats = () => stopStructuredAgentChats('antigravity', 'Antigravity')

// Running chats hold the old key until they start again; unrelated auth methods keep running.
const restartLiveKeyChats = (runtime: OrcaRuntimeService): Promise<void> =>
  savedChatAuthUsesGeminiApiKey(runtime.requireStore().getSettings().antigravityChatAuth)
    ? stopLiveChats().catch((error: unknown) =>
        console.warn('[antigravity] chats kept the previous key:', error)
      )
    : Promise.resolve()

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

/** Signs agy in where chats on agy's own home run it, with their environment. */
const agySignInHost = (runtime: OrcaRuntimeService): AntigravityChatSignInHost => ({
  agy: async () => {
    // A launch restore that began before this sign-in finishes writing before agy's login can.
    await (await getAntigravityAccountService({ runtime: 'host' })).settled()
    const settings = runtime.requireStore().getSettings()
    const shellEnv = await resolveHostStructuredAgentLaunchEnvironment('antigravity', settings)
    const input = await acpHostBackendInput(
      ANTIGRAVITY_LAUNCH_SPEC,
      shellEnv,
      getProfileUserDataPath(),
      settings
    )
    if (!input || !isAbsolute(input.command)) {
      throw new Error('agy is not installed on this host. Install it, then sign in again.')
    }
    const env = { ...input.env }
    for (const key of input.envToDelete) {
      delete env[key]
    }
    return { command: input.command, env }
  },
  signedIn: async (intent) => {
    forgetAgyLogin(runtime)
    // A new login with no new selection: idle chats start again on it.
    restartIdleAgyChats({ runtime: 'host' })
    if (intent === 'changeAccount') {
      await saveCurrentAgyLogin()
    }
  }
})

/** Keeps agy's current login among the saved accounts, so adding another can't lose it; a host
 *  signed out has nothing to save. */
async function saveCurrentAgyLogin(): Promise<void> {
  try {
    await (await getAntigravityAccountService({ runtime: 'host' })).addCurrentAccount()
  } catch (error) {
    console.warn("[antigravity] agy's current login wasn't saved:", error)
  }
}

/** The caller a sign-in belongs to, as its transport proved it; one it can't name gets none. */
function signInOwner({ caller }: Pick<RpcContext, 'caller'>): string {
  if (!caller) {
    throw new Error('This client cannot sign Antigravity in.')
  }
  return rpcCallerOperationKey(caller)
}

type AccountService = Awaited<ReturnType<typeof getAntigravityAccountService>>

/** Runs `operation` on the target's accounts and adds where new chats run. */
const accountsAnswer =
  (operation: (service: AccountService) => ReturnType<AccountService['listAccounts']>) =>
  async (target: Parameters<typeof getAntigravityAccountService>[0], ctx: RpcContext) =>
    withAntigravityChatBackend(
      ctx.runtime,
      target,
      await operation(await getAntigravityAccountService(target))
    )

export const ANTIGRAVITY_ACCOUNT_METHODS = [
  defineMethod({
    name: 'accounts.antigravityList',
    permission: 'workspace',
    params: AntigravityAccountTargetParams,
    handler: accountsAnswer((service) => service.listAccounts())
  }),
  defineMethod({
    // Settings' Show account: reading agy's login may raise a keychain dialog, which List avoids.
    name: 'accounts.antigravityReadCurrent',
    permission: 'accounts-admin',
    params: AntigravityAccountTargetParams,
    handler: accountsAnswer((service) => service.readCurrentAccount())
  }),
  defineMethod({
    name: 'accounts.antigravityAddCurrent',
    permission: 'accounts-admin',
    params: AntigravityAccountTargetParams,
    handler: accountsAnswer((service) => service.addCurrentAccount())
  }),
  defineMethod({
    name: 'accounts.antigravitySelect',
    permission: 'accounts-admin',
    params: AntigravityAccountMutationParams,
    handler: async ({ target, accountId }, ctx) => {
      // The sign-in writes agy's login itself; a switch now would race it.
      if (target.runtime === 'host' && antigravitySignInHoldsNativeLogin()) {
        throw new Error('Antigravity is signing in. Select an account after it finishes.')
      }
      const service = await getAntigravityAccountService(target)
      let switched = false
      // New chats use the account at once; running ones move at their next send (the selection
      // noted by the host's vault drives that).
      const state = await service.selectAccount(accountId, () => (switched = true))
      if (target.runtime === 'host') {
        // agy's login now verifiably holds it: chats a failed move held back follow at their next send.
        AGY_HOST_SELECTION.prepared({ key: accountId, target: accountId })
        // Chats run only on the host's agy; what they listed belongs to the previous account.
        if (switched) {
          forgetAgyLogin(ctx.runtime)
        }
      }
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
    handler: async ({ intent }, ctx) => {
      const owner = signInOwner(ctx)
      // Adding an account replaces agy's login, so the one it has is saved first; a failed save
      // refuses the sign-in rather than lose that login.
      if (intent === 'changeAccount') {
        const accounts = await getAntigravityAccountService({ runtime: 'host' })
        if ((await accounts.listAccounts()).currentAccount) {
          await accounts.addCurrentAccount()
        }
      }
      return startAntigravityChatSignIn(agySignInHost(ctx.runtime), owner, intent)
    }
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
      readAgySignInInBackground(ctx.runtime)
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
      applyAntigravityChatAuthConfig(ctx.runtime.requireStore(), config, stopLiveChats)
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
    handler: (_, ctx) => {
      readAgySignInInBackground(ctx.runtime)
      return detectChatAuth(ctx.runtime)
    }
  }),
  defineMethod({
    name: 'accounts.antigravityChatApiKeySave',
    permission: 'accounts-admin',
    params: AntigravityChatApiKeySaveParams,
    handler: async ({ apiKey }, ctx) => {
      await storeAntigravityChatApiKey(apiKey)
      onAntigravityChatApiKeyChanged()
      await restartLiveKeyChats(ctx.runtime)
      return apiKeyStatus(ctx.runtime)
    }
  }),
  defineMethod({
    name: 'accounts.antigravityChatApiKeyClear',
    permission: 'accounts-admin',
    params: null,
    handler: async (_, ctx) => {
      await clearAntigravityChatApiKey()
      onAntigravityChatApiKeyChanged()
      await restartLiveKeyChats(ctx.runtime)
      return apiKeyStatus(ctx.runtime)
    }
  })
] as const
