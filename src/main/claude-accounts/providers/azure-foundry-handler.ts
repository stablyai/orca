import {
  readManagedClaudeKeychainCredentials,
  writeManagedClaudeKeychainCredentials
} from '../keychain'
import { getDefaultModelMapping } from '../model-defaults'
import { detectAzureEntraIdSignIn, getEntraAccessTokenForCognitiveServices } from './azure-cli'

const VALIDATE_TIMEOUT_MS = 500
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
  if (merged.opus) {
    env.ANTHROPIC_DEFAULT_OPUS_MODEL = merged.opus
  }
  if (merged.sonnet) {
    env.ANTHROPIC_DEFAULT_SONNET_MODEL = merged.sonnet
  }
  if (merged.haiku) {
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL = merged.haiku
  }
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
      if (useEntraId) {
        const detection = await detectAzureEntraIdSignIn()
        if (!detection.ok) {
          if (detection.reason === 'az-not-installed') {
            throw new Error(
              'Azure CLI (`az`) is not installed. Install it from https://aka.ms/install-azure-cli and try again.'
            )
          }
          throw new Error('Not signed in to Azure. Run `az login` and try again.')
        }
        // No keychain write — Claude Code uses Entra ID via az's local token cache at launch
      } else {
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
          throw new Error(
            `Azure Foundry API key for account ${account.id} is missing from Keychain.`
          )
        }
        env.ANTHROPIC_FOUNDRY_API_KEY = key
      }
      return { envPatch: env }
    },
    validate: async (account) => {
      const creds = account.credentials
      if (creds.authMethod !== 'azure-foundry') {
        return { ok: false, reason: 'Azure Foundry validate invoked on non-foundry account.' }
      }
      const url = `https://${creds.resource}.services.ai.azure.com/anthropic/v1/models`
      let headers: Record<string, string>
      if (creds.useEntraId) {
        const tokenResult = await getEntraAccessTokenForCognitiveServices()
        if (!tokenResult.ok) {
          // Why: surface the same locked string the 401 path uses so UI copy stays consistent.
          return {
            ok: false,
            reason: 'Azure Foundry token invalid or expired. Run `az login` and try again.',
            rescueHint: 'Run `az login` in your terminal.'
          }
        }
        headers = { Authorization: `Bearer ${tokenResult.token}` }
      } else {
        const key = await readManagedClaudeKeychainCredentials(account.id)
        if (!key) {
          return {
            ok: false,
            reason: 'Azure Foundry API key for this account is missing from Keychain.'
          }
        }
        // Why: Foundry's /anthropic endpoint speaks Anthropic's wire protocol so
        // it expects Anthropic's standard `x-api-key` + `anthropic-version`
        // headers, not Azure OpenAI's `api-key` header.
        headers = { 'x-api-key': key, 'anthropic-version': '2023-06-01' }
      }
      try {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), VALIDATE_TIMEOUT_MS)
        const response = await fetch(url, { method: 'GET', headers, signal: controller.signal })
        clearTimeout(timer)
        if (response.ok) {
          return { ok: true }
        }
        if (response.status === 401) {
          const reason = creds.useEntraId
            ? 'Azure Foundry token invalid or expired. Run `az login` and try again.'
            : 'Azure Foundry API key invalid or expired.'
          const rescueHint = creds.useEntraId
            ? 'Run `az login` in your terminal.'
            : 'Re-paste the API key from your Foundry project portal.'
          return { ok: false, reason, rescueHint }
        }
        if (response.status === 403) {
          return {
            ok: false,
            reason:
              "Foundry deployment does not allow Claude access. Check your workspace's model deployment.",
            rescueHint: 'Verify the Anthropic model is deployed in this Foundry resource.'
          }
        }
        return { ok: false, reason: `Foundry endpoint returned HTTP ${response.status}.` }
      } catch {
        return {
          ok: false,
          reason: 'Unable to reach Foundry endpoint. Check resource name and network.',
          rescueHint: 'Verify the resource name and your network connection.'
        }
      }
    }
  }
}
