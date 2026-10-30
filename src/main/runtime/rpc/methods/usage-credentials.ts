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

// Host pollers own these keys; replies expose presence/protection only. Hosts without pollers refuse calls (including WSL).
// Never overwrite keys sealed by another Orca app; forgetting them is allowed.
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
