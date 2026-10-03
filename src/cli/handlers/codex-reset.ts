import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type {
  AccountsSnapshot,
  CodexRateLimitResetRpcResult
} from '../../shared/runtime-account-types'
import { buildCodexResetCreditExpectedScope } from '../../shared/codex-reset-credit-scope'
import { CODEX_RESET_CREDIT_RUNTIME_CAPABILITY } from '../../shared/protocol-version'
import { ConsumeCodexResetCreditParams } from '../../shared/rpc-contract/accounts-params'
import type { RuntimeStatus } from '../../shared/runtime-types'
import type { CommandHandler, HandlerContext } from '../dispatch'
import { printResult } from '../format'
import { rejectRemoteSelectionFlags } from '../remote-selection-flag-rejection'
import { RuntimeClientError, type RuntimeRpcSuccess } from '../runtime-client'

function stringFlag(ctx: HandlerContext, name: string): string | undefined {
  const value = ctx.flags.get(name)
  if (value === undefined) {
    return undefined
  }
  if (typeof value !== 'string' || !value.trim()) {
    throw new RuntimeClientError('invalid_argument', `Missing a value for --${name}.`)
  }
  return value
}

async function requireResetSupport(ctx: HandlerContext): Promise<void> {
  const status = await ctx.client.call<RuntimeStatus>('status.get')
  if (!status.result.capabilities?.includes(CODEX_RESET_CREDIT_RUNTIME_CAPABILITY)) {
    throw new RuntimeClientError(
      'incompatible_runtime',
      'The running Orca runtime does not support scoped Codex resets. Update Orca and try again.'
    )
  }
}

async function previewReset(ctx: HandlerContext, accountId: string, output: string): Promise<void> {
  const response = await ctx.client.call<AccountsSnapshot>('accounts.list', { refreshUsage: false })
  const { codex, rateLimits } = response.result
  const target = rateLimits.codexTarget
  const selectedId =
    target.runtime === 'host'
      ? (codex.activeAccountIdsByRuntime?.host ?? codex.activeAccountId)
      : codex.activeAccountIdsByRuntime?.wsl[target.wslDistro ?? '']
  if (selectedId !== accountId) {
    throw new RuntimeClientError(
      'invalid_argument',
      'The requested account is not selected for the active Codex usage runtime. No account was switched.'
    )
  }
  const account = codex.accounts.find((candidate) => candidate.id === accountId) ?? null
  const expectedScope = buildCodexResetCreditExpectedScope({
    target,
    account,
    limits: rateLimits.codex
  })
  if (!expectedScope || !account) {
    throw new RuntimeClientError(
      'reset_unavailable',
      'No scoped reset offer is available for this managed account. Refresh Codex usage in Orca and check its reset credits.'
    )
  }
  const request = { idempotencyKey: randomUUID(), expectedScope }
  const requestFile = resolve(ctx.cwd, output)
  // Preserve the exact scope and key before any provider mutation; never overwrite an earlier attempt.
  writeFileSync(requestFile, `${JSON.stringify(request, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  const preview = {
    status: 'preview',
    accountId,
    email: account.email,
    target,
    availableCredits: rateLimits.codex?.rateLimitResetCredits?.availableCount,
    requestFile,
    request
  }
  printResult({ ...response, result: preview }, ctx.json, (value) =>
    [
      `No reset performed. Account: ${value.email} (${value.accountId}).`,
      `Runtime: ${target.runtime}${target.wslDistro ? ` (${target.wslDistro})` : ''}.`,
      `Available reset credits: ${value.availableCredits}.`,
      'Confirmation spends one reset credit to reset eligible server-side usage windows.',
      `Request saved to: ${value.requestFile}`,
      'Review the file, then run `orca account reset-codex-limits --request-file <path> --confirm`.',
      'If the response is lost, retry with that same file; do not generate a new request.'
    ].join('\n')
  )
}

async function confirmReset(ctx: HandlerContext, file: string): Promise<void> {
  let contents: unknown
  try {
    contents = JSON.parse(readFileSync(resolve(ctx.cwd, file), 'utf8'))
  } catch {
    throw new RuntimeClientError('invalid_argument', 'Cannot read a reset request JSON file.')
  }
  const request = ConsumeCodexResetCreditParams.safeParse(contents)
  if (!request.success) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Invalid reset request. Use the unchanged file from the preview.'
    )
  }
  await requireResetSupport(ctx)
  let response: RuntimeRpcSuccess<CodexRateLimitResetRpcResult>
  try {
    // Do not refetch or rebuild the offer here: a retry must retain the original scope and key.
    response = await ctx.client.call<CodexRateLimitResetRpcResult>(
      'accounts.consumeCodexResetCredit',
      request.data
    )
  } catch (error) {
    throw new RuntimeClientError(
      error instanceof RuntimeClientError ? error.code : 'internal',
      `${error instanceof Error ? error.message : 'Reset request failed.'} Retry only with the same request file.`,
      { requestFile: resolve(ctx.cwd, file), idempotencyKey: request.data.idempotencyKey }
    )
  }
  if ('status' in response.result) {
    throw new RuntimeClientError(
      'reset_scope_changed',
      `Reset rejected before contacting the provider: ${response.result.reason}. Review a new preview before confirming again.`,
      response.result
    )
  }
  printResult(response, ctx.json, (result) => {
    if ('status' in result) {
      return result.reason
    }
    const outcomes = {
      reset: 'Eligible Codex server-side usage windows were reset.',
      nothingToReset: 'There are no eligible usage windows to reset.',
      noCredit: 'No Codex reset credit is available.',
      alreadyRedeemed: 'This reset request was already redeemed.'
    }
    return `${outcomes[result.outcome]} Account: ${result.scope.accountId}.`
  })
}

export const CODEX_RESET_HANDLERS: Record<string, CommandHandler> = {
  'account reset-codex-limits': async (ctx) => {
    rejectRemoteSelectionFlags(
      ctx.flags,
      '`orca account reset-codex-limits`. Run it on the host that owns the account.'
    )
    const account = stringFlag(ctx, 'account')
    const output = stringFlag(ctx, 'out')
    const requestFile = stringFlag(ctx, 'request-file')
    const confirm = ctx.flags.get('confirm')
    if (confirm !== undefined && confirm !== true) {
      throw new RuntimeClientError(
        'invalid_argument',
        'Use bare --confirm to authorize spending one reset credit.'
      )
    }
    if (requestFile) {
      if (confirm !== true || account !== undefined || output !== undefined) {
        throw new RuntimeClientError(
          'invalid_argument',
          'Use --request-file with --confirm, without --account or --out.'
        )
      }
      await confirmReset(ctx, requestFile)
      return
    }
    if (confirm !== undefined || !account || !output) {
      throw new RuntimeClientError(
        'invalid_argument',
        'Preview with --account <id> --out <new-file>; confirm with --request-file <file> --confirm.'
      )
    }
    await requireResetSupport(ctx)
    await previewReset(ctx, account, output)
  }
}
