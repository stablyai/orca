import { defineMethod } from '../core'
import {
  UsageCredentialApiKeyParams,
  UsageCredentialSessionCookieParams
} from '../../../../shared/rpc-contract/usage-credentials-params'
import {
  assertMiniMaxCredentialOpensHere,
  clearMiniMaxApiKeyCredential,
  clearMiniMaxSessionCookieCredential,
  getMiniMaxCredentialsStatus,
  saveMiniMaxApiKeyCredential,
  saveMiniMaxSessionCookieCredential
} from '../../../minimax/minimax-credential-commands'
import {
  assertZcodePlanApiKeyOpensHere,
  clearZcodePlanApiKeyCredential,
  getZcodePlanCredentialsStatus,
  saveZcodePlanApiKeyCredential
} from '../../../zcode/zcode-plan-credential-commands'

// Why on the host: its own usage poller reads these keys, so a paired client saves them here.
// Statuses carry presence and protection only; a key never travels back to a client. A host with
// no poller (a WSL host, whose desktop owns its accounts) refuses every call instead, and a key the
// other Orca app on this machine sealed is never overwritten from here (forgetting it is allowed).
export const USAGE_CREDENTIAL_METHODS = [
  defineMethod({
    name: 'accounts.minimaxCredentialsStatus',
    permission: 'workspace',
    params: null,
    handler: async (_, { runtime }) => {
      runtime.requireUsageRateLimits()
      return getMiniMaxCredentialsStatus()
    }
  }),
  defineMethod({
    name: 'accounts.minimaxSaveApiKey',
    permission: 'accounts-admin',
    params: UsageCredentialApiKeyParams,
    handler: async ({ apiKey }, { runtime }) => {
      const rateLimits = runtime.requireUsageRateLimits()
      assertMiniMaxCredentialOpensHere('apiKey')
      return saveMiniMaxApiKeyCredential(rateLimits, apiKey)
    }
  }),
  defineMethod({
    name: 'accounts.minimaxClearApiKey',
    permission: 'accounts-admin',
    params: null,
    handler: async (_, { runtime }) => {
      const rateLimits = runtime.requireUsageRateLimits()
      return clearMiniMaxApiKeyCredential(rateLimits)
    }
  }),
  defineMethod({
    name: 'accounts.minimaxSaveSessionCookie',
    permission: 'accounts-admin',
    params: UsageCredentialSessionCookieParams,
    handler: async ({ cookie }, { runtime }) => {
      const rateLimits = runtime.requireUsageRateLimits()
      assertMiniMaxCredentialOpensHere('cookie')
      return saveMiniMaxSessionCookieCredential(rateLimits, cookie)
    }
  }),
  defineMethod({
    name: 'accounts.minimaxClearSessionCookie',
    permission: 'accounts-admin',
    params: null,
    handler: async (_, { runtime }) => {
      const rateLimits = runtime.requireUsageRateLimits()
      return clearMiniMaxSessionCookieCredential(rateLimits)
    }
  }),
  defineMethod({
    name: 'accounts.zcodePlanCredentialsStatus',
    permission: 'workspace',
    params: null,
    handler: async (_, { runtime }) => {
      runtime.requireUsageRateLimits()
      return getZcodePlanCredentialsStatus()
    }
  }),
  defineMethod({
    name: 'accounts.zcodePlanSaveApiKey',
    permission: 'accounts-admin',
    params: UsageCredentialApiKeyParams,
    handler: async ({ apiKey }, { runtime }) => {
      const rateLimits = runtime.requireUsageRateLimits()
      assertZcodePlanApiKeyOpensHere()
      return saveZcodePlanApiKeyCredential(rateLimits, apiKey)
    }
  }),
  defineMethod({
    name: 'accounts.zcodePlanClearApiKey',
    permission: 'accounts-admin',
    params: null,
    handler: async (_, { runtime }) => {
      const rateLimits = runtime.requireUsageRateLimits()
      return clearZcodePlanApiKeyCredential(rateLimits)
    }
  })
] as const
