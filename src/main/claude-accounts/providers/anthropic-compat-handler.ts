import {
  readManagedClaudeKeychainCredentials,
  writeManagedClaudeKeychainCredentials
} from '../keychain'
import { getDefaultBaseUrl, getDefaultModelMapping } from '../model-defaults'
import { probeAnthropicAuth } from './probe-anthropic-auth'
import type { ProviderHandler } from './types'
import type {
  AnthropicCompatPreset,
  ClaudeManagedAccount,
  ClaudeModelMapping
} from '../../../shared/types'

function emitModelEnv(account: ClaudeManagedAccount): Record<string, string> {
  const defaults = getDefaultModelMapping(account.credentials)
  const merged: ClaudeModelMapping = { ...defaults, ...account.modelMapping }
  const env: Record<string, string> = {}
  if (merged.opus) env.ANTHROPIC_DEFAULT_OPUS_MODEL = merged.opus
  if (merged.sonnet) env.ANTHROPIC_DEFAULT_SONNET_MODEL = merged.sonnet
  if (merged.haiku) env.ANTHROPIC_DEFAULT_HAIKU_MODEL = merged.haiku
  return env
}

export function createAnthropicCompatHandler(): ProviderHandler {
  return {
    authMethod: 'anthropic-compat',
    registerAccount: async (input) => {
      const token = input.secretFromUser?.trim()
      if (!token) {
        throw new Error('Provider auth token is required.')
      }
      const preset = (input.providerConfig as { preset?: AnthropicCompatPreset } | undefined)
        ?.preset
      if (!preset) {
        throw new Error('Provider preset is required (zai, kimi, minimax, or custom).')
      }
      const explicitBaseUrl = (
        input.providerConfig as { baseUrl?: string } | undefined
      )?.baseUrl?.trim()
      const baked = getDefaultBaseUrl(preset)
      const baseUrl = explicitBaseUrl || baked
      if (!baseUrl) {
        throw new Error('Base URL is required for the custom Anthropic-compatible provider.')
      }
      await writeManagedClaudeKeychainCredentials(input.accountId, token)
      return {
        accountId: input.accountId,
        email: input.label?.trim() || `${preset} account`,
        credentials: { authMethod: 'anthropic-compat', baseUrl, preset },
        organizationUuid: null,
        organizationName: null
      }
    },
    materialize: async (account) => {
      const token = await readManagedClaudeKeychainCredentials(account.id)
      if (!token) {
        throw new Error(`Provider token for account ${account.id} is missing from Keychain.`)
      }
      const creds = account.credentials
      if (creds.authMethod !== 'anthropic-compat') {
        throw new Error('Anthropic-compat handler invoked on non-compat account.')
      }
      return {
        envPatch: {
          ANTHROPIC_BASE_URL: creds.baseUrl,
          ANTHROPIC_AUTH_TOKEN: token,
          ...emitModelEnv(account)
        }
      }
    },
    validate: async (account) => {
      const token = await readManagedClaudeKeychainCredentials(account.id)
      if (!token) {
        return {
          ok: false,
          reason: 'Provider token is missing from Keychain.',
          rescueHint: 'Re-add this account.'
        }
      }
      const creds = account.credentials
      if (creds.authMethod !== 'anthropic-compat') {
        return { ok: false, reason: 'Invalid credentials shape for compat handler.' }
      }
      const baseUrl = creds.baseUrl.replace(/\/$/, '')
      return probeAnthropicAuth({
        url: `${baseUrl}/v1/models`,
        headers: { 'x-api-key': token, 'anthropic-version': '2023-06-01' },
        reason401: 'Provider token invalid or revoked.',
        rescue401: "Generate a new token in the provider's dashboard and try again.",
        rescue403:
          "Confirm your provider workspace has Claude-compatible API access enabled."
      })
    }
  }
}
