import type { CommandHandler } from '../dispatch'
import { RuntimeClientError } from '../runtime-client'
import { getRequiredStringFlag, getOptionalStringFlag } from '../flags'

type AddResult = {
  accountId: string
  email: string
  accounts: unknown[]
  activeAccountId?: string
}

// Why: when no Orca app is reachable the IPC transport fails with
// runtime_unavailable. We retry via the in-process headless bootstrap so the
// CLI still works in environments without a running Electron UI (e.g. SSH,
// CI). The headless module is imported dynamically so the CLI does not pull
// main-process modules at startup.
function isRuntimeUnavailable(error: unknown): boolean {
  return error instanceof RuntimeClientError && error.code === 'runtime_unavailable'
}

async function callOrHeadless<T>(
  ctx: Parameters<CommandHandler>[0],
  rpc: string,
  payload: unknown,
  headless: () => Promise<T>
): Promise<T> {
  try {
    const response = await ctx.client.call<T>(rpc, payload as never)
    return response.result
  } catch (error) {
    if (isRuntimeUnavailable(error)) {
      return headless()
    }
    throw error
  }
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

// Why: every provider branch ends the same way — optionally probe the new
// credential via claudeAccounts.validate, then emit the success envelope.
// Extracting this keeps each provider branch focused on payload shape.
async function finishAdd(ctx: Parameters<CommandHandler>[0], result: AddResult): Promise<void> {
  if (ctx.flags.get('validate') === true) {
    const probe = await callOrHeadless<{ ok: boolean; error?: string }>(
      ctx,
      'claudeAccounts.validate',
      { accountId: result.accountId },
      // Why: validate runs a live network probe via the provider handler. The
      // headless service does not yet expose validateAccount; surface a clear
      // error rather than silently skipping validation.
      async () => {
        throw new RuntimeClientError(
          'runtime_unavailable',
          'Cannot validate accounts without a running Orca app.'
        )
      }
    )
    if (!probe.ok) {
      throw new RuntimeClientError(
        'invalid_argument',
        `Validation failed for account ${result.accountId}: ${probe.error ?? 'unknown'}`
      )
    }
  }
  emitOk(result.accountId, result.email)
}

type AddPayload = Record<string, unknown> & { authMethod: string }

async function dispatchAdd(
  ctx: Parameters<CommandHandler>[0],
  payload: AddPayload
): Promise<AddResult> {
  return callOrHeadless<AddResult>(ctx, 'claudeAccounts.add', payload, async () => {
    const { runHeadlessClaudeAccountsAdd } =
      await import('../../main/claude-accounts/headless-bootstrap')
    return runHeadlessClaudeAccountsAdd(payload as never)
  })
}

async function handleAdd(ctx: Parameters<CommandHandler>[0]): Promise<void> {
  const provider = getRequiredStringFlag(ctx.flags, 'provider')
  try {
    if (provider === 'anthropic-api-key') {
      const label = getRequiredStringFlag(ctx.flags, 'label')
      const secret = readSecretFromEnv(ctx.flags, 'key-env')
      const result = await dispatchAdd(ctx, {
        authMethod: 'anthropic-api-key',
        label,
        secretFromUser: secret
      })
      await finishAdd(ctx, result)
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
      const result = await dispatchAdd(ctx, {
        authMethod: 'anthropic-compat',
        label,
        secretFromUser: secret,
        providerConfig
      })
      await finishAdd(ctx, result)
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
      const payload: AddPayload = {
        authMethod: 'azure-foundry',
        label,
        providerConfig: { resource, authMode: useEntra ? 'entra-id' : 'api-key' }
      }
      if (!useEntra) {
        payload.secretFromUser = readSecretFromEnv(ctx.flags, 'key-env')
      }
      const result = await dispatchAdd(ctx, payload)
      await finishAdd(ctx, result)
      return
    }
    if (provider === 'aws-bedrock') {
      const region = getRequiredStringFlag(ctx.flags, 'region')
      const tokenEnv = getOptionalStringFlag(ctx.flags, 'token-env')
      const label = getOptionalStringFlag(ctx.flags, 'label') ?? region
      // Why: presence of --token-env picks bearer-token mode; absence falls
      // through to the SDK's IAM credential chain (env / SSO / role).
      const providerConfig: Record<string, unknown> = {
        region,
        authMode: tokenEnv ? 'bearer-token' : 'iam-chain'
      }
      const payload: AddPayload = {
        authMethod: 'aws-bedrock',
        label,
        providerConfig
      }
      if (tokenEnv) {
        payload.secretFromUser = readSecretFromEnv(ctx.flags, 'token-env')
      }
      const result = await dispatchAdd(ctx, payload)
      await finishAdd(ctx, result)
      return
    }
    if (provider === 'google-vertex') {
      // Why: Vertex uses Application Default Credentials — no secret to store.
      // The runtime authenticates via gcloud ADC / workload identity.
      const projectId = getRequiredStringFlag(ctx.flags, 'project-id')
      const region = getRequiredStringFlag(ctx.flags, 'region')
      const label = getOptionalStringFlag(ctx.flags, 'label') ?? projectId
      const result = await dispatchAdd(ctx, {
        authMethod: 'google-vertex',
        label,
        providerConfig: { projectId, region, authMode: 'adc' }
      })
      await finishAdd(ctx, result)
      return
    }
    throw new RuntimeClientError('invalid_argument', `Unknown --provider value: ${provider}`)
  } catch (error) {
    emitFail(error)
  }
}

async function handleList(ctx: Parameters<CommandHandler>[0]): Promise<void> {
  try {
    const result = await callOrHeadless<{ accounts: unknown[] }>(
      ctx,
      'claudeAccounts.list',
      {},
      async () => {
        const { runHeadlessClaudeAccountsList } =
          await import('../../main/claude-accounts/headless-bootstrap')
        return runHeadlessClaudeAccountsList()
      }
    )
    console.log(JSON.stringify({ ok: true, accounts: result.accounts }))
  } catch (error) {
    emitFail(error)
  }
}

async function handleSelect(ctx: Parameters<CommandHandler>[0]): Promise<void> {
  try {
    const accountId = getRequiredStringFlag(ctx.flags, 'account-id')
    const result = await callOrHeadless<{ activeAccountId: string }>(
      ctx,
      'claudeAccounts.select',
      { accountId },
      async () => {
        const { runHeadlessClaudeAccountsSelect } =
          await import('../../main/claude-accounts/headless-bootstrap')
        return runHeadlessClaudeAccountsSelect(accountId)
      }
    )
    console.log(JSON.stringify({ ok: true, activeAccountId: result.activeAccountId }))
  } catch (error) {
    emitFail(error)
  }
}

async function handleRemove(ctx: Parameters<CommandHandler>[0]): Promise<void> {
  try {
    const accountId = getRequiredStringFlag(ctx.flags, 'account-id')
    const result = await callOrHeadless<{ removed: boolean }>(
      ctx,
      'claudeAccounts.remove',
      { accountId },
      async () => {
        const { runHeadlessClaudeAccountsRemove } =
          await import('../../main/claude-accounts/headless-bootstrap')
        return runHeadlessClaudeAccountsRemove(accountId)
      }
    )
    console.log(JSON.stringify({ ok: true, removed: result.removed }))
  } catch (error) {
    emitFail(error)
  }
}

export const CLAUDE_ACCOUNTS_HANDLERS: Record<string, CommandHandler> = {
  'claude-accounts add': handleAdd,
  'claude-accounts list': handleList,
  'claude-accounts select': handleSelect,
  'claude-accounts remove': handleRemove
}
