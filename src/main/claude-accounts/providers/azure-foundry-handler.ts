import {
  readManagedClaudeKeychainCredentials,
  writeManagedClaudeKeychainCredentials
} from '../keychain'
import { getDefaultModelMapping } from '../model-defaults'
import type { ProviderHandler } from './types'
import type { ClaudeManagedAccount, ClaudeModelMapping } from '../../../shared/types'

type FoundryProviderConfig = {
  resource?: string
  baseUrl?: string
  useEntraId?: boolean
}

function emitModelEnv(account: ClaudeManagedAccount): Record<string, string> {
  const defaults = getDefaultModelMapping(account.credentials)
  const merged: ClaudeModelMapping = { ...defaults, ...account.modelMapping }
  const env: Record<string, string> = {}
  if (merged.opus) env.ANTHROPIC_DEFAULT_OPUS_MODEL = merged.opus
  if (merged.sonnet) env.ANTHROPIC_DEFAULT_SONNET_MODEL = merged.sonnet
  if (merged.haiku) env.ANTHROPIC_DEFAULT_HAIKU_MODEL = merged.haiku
  return env
}

export function createAzureFoundryHandler(): ProviderHandler {
  return {
    authMethod: 'azure-foundry',
    registerAccount: async (input) => {
      const cfg = (input.providerConfig as FoundryProviderConfig | undefined) ?? {}
      const resource = cfg.resource?.trim()
      if (!resource) {
        throw new Error('Azure Foundry resource name is required.')
      }
      const useEntraId = cfg.useEntraId === true
      if (!useEntraId) {
        const key = input.secretFromUser?.trim()
        if (!key) {
          throw new Error('Azure Foundry API key is required when not using Entra ID.')
        }
        await writeManagedClaudeKeychainCredentials(input.accountId, key)
      }
      return {
        accountId: input.accountId,
        email: input.label?.trim() || `Foundry (${resource})`,
        credentials: { authMethod: 'azure-foundry', resource, useEntraId },
        organizationUuid: null,
        organizationName: null
      }
    },
    materialize: async (account) => {
      const creds = account.credentials
      if (creds.authMethod !== 'azure-foundry') {
        throw new Error('Azure Foundry handler invoked on non-foundry account.')
      }
      const env: Record<string, string> = {
        CLAUDE_CODE_USE_FOUNDRY: '1',
        ANTHROPIC_FOUNDRY_RESOURCE: creds.resource,
        ...emitModelEnv(account)
      }
      if (!creds.useEntraId) {
        const key = await readManagedClaudeKeychainCredentials(account.id)
        if (!key) {
          throw new Error(`Azure Foundry API key for account ${account.id} is missing from Keychain.`)
        }
        env.ANTHROPIC_FOUNDRY_API_KEY = key
      }
      return { envPatch: env }
    },
    validate: async () => ({ ok: true })  // expanded in T7
  }
}
