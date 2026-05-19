import type { CommandHandler } from '../dispatch'
import { RuntimeClientError } from '../runtime-client'
import { getRequiredStringFlag, getOptionalStringFlag } from '../flags'

type AddResult = {
  accountId: string
  email: string
  accounts: unknown[]
  activeAccountId?: string
}

// Why: --key-env / --token-env carry the env var NAME, not the secret. Reading
// the secret here keeps it out of argv and out of any shell history transcript.
function readSecretFromEnv(flags: Map<string, string | boolean>, flagName: string): string {
  const envName = getRequiredStringFlag(flags, flagName)
  const value = process.env[envName]
  if (typeof value !== 'string' || value.length === 0) {
    throw new RuntimeClientError(
      'invalid_argument',
      `Environment variable ${envName} (referenced by --${flagName}) is unset or empty.`
    )
  }
  return value
}

function emitOk(accountId: string, email: string): void {
  console.log(JSON.stringify({ ok: true, accountId, email }))
}

function emitFail(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error)
  console.log(JSON.stringify({ ok: false, error: message }))
  process.exitCode = 1
  throw error instanceof Error ? error : new Error(message)
}

async function handleAdd(ctx: Parameters<CommandHandler>[0]): Promise<void> {
  const provider = getRequiredStringFlag(ctx.flags, 'provider')
  try {
    if (provider === 'anthropic-api-key') {
      const label = getRequiredStringFlag(ctx.flags, 'label')
      const secret = readSecretFromEnv(ctx.flags, 'key-env')
      const response = await ctx.client.call<AddResult>('claudeAccounts.add', {
        authMethod: 'anthropic-api-key',
        label,
        secretFromUser: secret
      })
      emitOk(response.result.accountId, response.result.email)
      return
    }
    if (provider === 'anthropic-compat') {
      const preset = getRequiredStringFlag(ctx.flags, 'preset')
      const label = getRequiredStringFlag(ctx.flags, 'label')
      const secret = readSecretFromEnv(ctx.flags, 'token-env')
      const baseUrl = getOptionalStringFlag(ctx.flags, 'base-url')
      if (preset === 'custom' && !baseUrl) {
        throw new RuntimeClientError(
          'invalid_argument',
          'Provider preset "custom" requires --base-url.'
        )
      }
      const providerConfig: Record<string, string> = { preset }
      if (baseUrl) {
        providerConfig.baseUrl = baseUrl
      }
      const response = await ctx.client.call<AddResult>('claudeAccounts.add', {
        authMethod: 'anthropic-compat',
        label,
        secretFromUser: secret,
        providerConfig
      })
      emitOk(response.result.accountId, response.result.email)
      return
    }
    if (provider === 'azure-foundry') {
      const resource = getRequiredStringFlag(ctx.flags, 'resource')
      const useEntra = ctx.flags.get('use-entra-id') === true
      const keyEnvFlag = getOptionalStringFlag(ctx.flags, 'key-env')
      // Why: the two auth modes are mutually exclusive — picking both is
      // ambiguous, so fail fast before any secret read.
      if (useEntra && keyEnvFlag) {
        throw new RuntimeClientError(
          'invalid_argument',
          'Choose either --use-entra-id or --key-env for azure-foundry, not both.'
        )
      }
      if (!useEntra && !keyEnvFlag) {
        throw new RuntimeClientError(
          'invalid_argument',
          'azure-foundry requires either --use-entra-id or --key-env.'
        )
      }
      const label = getOptionalStringFlag(ctx.flags, 'label') ?? resource
      const payload: Record<string, unknown> = {
        authMethod: 'azure-foundry',
        label,
        providerConfig: { resource, authMode: useEntra ? 'entra-id' : 'api-key' }
      }
      if (!useEntra) {
        payload.secretFromUser = readSecretFromEnv(ctx.flags, 'key-env')
      }
      const result = await ctx.client.call<AddResult>('claudeAccounts.add', payload)
      emitOk(result.result.accountId, result.result.email)
      return
    }
    throw new RuntimeClientError('invalid_argument', `Unknown --provider value: ${provider}`)
  } catch (error) {
    emitFail(error)
  }
}

export const CLAUDE_ACCOUNTS_HANDLERS: Record<string, CommandHandler> = {
  'claude-accounts add': handleAdd
}
