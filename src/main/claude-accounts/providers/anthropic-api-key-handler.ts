import {
  readManagedClaudeKeychainCredentials,
  writeManagedClaudeKeychainCredentials
} from '../keychain'
import { getDefaultModelMapping } from '../model-defaults'
import type { ProviderHandler } from './types'
import type { ClaudeManagedAccount, ClaudeModelMapping } from '../../../shared/types'

function emitModelEnv(account: ClaudeManagedAccount): Record<string, string> {
  const defaults = getDefaultModelMapping(account.credentials)
  const merged: ClaudeModelMapping = { ...defaults, ...account.modelMapping }
  const env: Record<string, string> = {}
  if (merged.opus) env.ANTHROPIC_DEFAULT_OPUS_MODEL = merged.opus
  if (merged.sonnet) env.ANTHROPIC_DEFAULT_SONNET_MODEL = merged.sonnet
  if (merged.haiku) env.ANTHROPIC_DEFAULT_HAIKU_MODEL = merged.haiku
  return env
}

export function createAnthropicApiKeyHandler(): ProviderHandler {
  return {
    authMethod: 'anthropic-api-key',
    registerAccount: async (input) => {
      const key = input.secretFromUser?.trim()
      if (!key) {
        throw new Error('Anthropic API key is required.')
      }
      await writeManagedClaudeKeychainCredentials(input.accountId, key)
      return {
        accountId: input.accountId,
        email: input.label?.trim() || 'Anthropic API key',
        credentials: { authMethod: 'anthropic-api-key' },
        organizationUuid: null,
        organizationName: null
      }
    },
    materialize: async (account) => {
      const key = await readManagedClaudeKeychainCredentials(account.id)
      if (!key) {
        throw new Error(`Anthropic API key for account ${account.id} is missing from Keychain.`)
      }
      return {
        envPatch: {
          ANTHROPIC_API_KEY: key,
          ...emitModelEnv(account)
        }
      }
    },
    validate: async () => ({ ok: true })
  }
}
