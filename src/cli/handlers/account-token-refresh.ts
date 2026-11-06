import type { HandlerContext } from '../dispatch'
import { RuntimeClientError } from '../runtime-client'
import type {
  ClaudeRateLimitAccountsState,
  ClaudeTokenRefreshNowResult
} from '../../shared/managed-account-types'

/**
 * `orca account token-refresh --agent claude --on|--off|--status|--now`:
 * writes whether idle Claude accounts refresh, prints the book, or refreshes one account.
 *
 * Why no remote-flag rejection: the book and the setting live on the runtime that holds
 * the accounts, so `--environment <server>` is how a headless host is configured.
 */
export async function setClaudeAccountTokenRefresh(ctx: HandlerContext): Promise<void> {
  const agent = ctx.flags.get('agent') ?? 'claude'
  if (agent !== 'claude') {
    throw new RuntimeClientError(
      'invalid_argument',
      'Only --agent claude supports token-refresh today.'
    )
  }
  const on = ctx.flags.get('on') === true
  const off = ctx.flags.get('off') === true
  const status = ctx.flags.get('status') === true
  const nowFlag = ctx.flags.get('now')
  const force = ctx.flags.get('force') === true
  if (nowFlag === true) {
    throw new RuntimeClientError('invalid_argument', 'Pass --now <email|id>.')
  }
  const now = typeof nowFlag === 'string' ? nowFlag : null
  if (force && now === null) {
    throw new RuntimeClientError('invalid_argument', 'Pass --force only with --now <email|id>.')
  }
  if (Number(on) + Number(off) + Number(status) + Number(now !== null) !== 1) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Pass exactly one of --on, --off, --status, or --now <email|id>.'
    )
  }
  if (now !== null) {
    const result = await ctx.client.call<ClaudeTokenRefreshNowResult>(
      'accounts.refreshClaudeAccountTokenNow',
      { account: now, ...(force ? { force: true } : {}) }
    )
    printClaudeTokenRefreshNow(result.result, ctx.json)
    return
  }
  if (status) {
    const result = await ctx.client.call<{ claude: ClaudeRateLimitAccountsState }>(
      'accounts.list',
      { refreshUsage: false }
    )
    printClaudeTokenRefreshStatus(result.result.claude, ctx.json)
    return
  }
  const result = await ctx.client.call<ClaudeRateLimitAccountsState>(
    'accounts.setClaudeAccountTokenRefresh',
    { enabled: on }
  )
  printClaudeTokenRefreshStatus(result.result, ctx.json)
}

function printClaudeTokenRefreshNow(result: ClaudeTokenRefreshNowResult, json: boolean): void {
  const safe = {
    accountId: result.accountId,
    ...(result.email ? { email: result.email } : {}),
    outcome: result.outcome,
    ...(result.reason ? { reason: result.reason } : {})
  }
  if (json) {
    console.log(JSON.stringify(safe, null, 2))
    return
  }
  const label = result.email || result.accountId
  if (result.outcome === 'ok') {
    console.log(`refresh ${label} ok`)
    return
  }
  if (result.outcome === 'lapsed') {
    console.log(`refresh ${label} lapsed`)
    return
  }
  if (result.outcome === 'skipped') {
    console.log(`refresh ${label} skipped=${result.reason ?? 'skipped'}`)
    return
  }
  console.log(`refresh ${label} failed=${result.reason ?? 'failed'}`)
}

function printClaudeTokenRefreshStatus(state: ClaudeRateLimitAccountsState, json: boolean): void {
  const tokenRefresh = state.tokenRefresh ?? 'on'
  const accounts = (state.tokenRefreshAccounts ?? []).map((row) => ({
    accountId: row.accountId,
    lastRefreshAt: row.lastRefreshAt,
    nextRetryAt: row.nextRetryAt,
    lapsed: row.lapsed,
    queuePosition: row.queuePosition ?? null,
    backoffLevel: row.backoffLevel ?? 0
  }))
  if (json) {
    console.log(JSON.stringify({ tokenRefresh, accounts }, null, 2))
    return
  }
  const lines = [`Claude token-refresh: ${tokenRefresh}`]
  if (accounts.length === 0) {
    lines.push('  accounts: none')
  }
  for (const row of accounts) {
    const queued = row.queuePosition === null ? '—' : `#${row.queuePosition}`
    lines.push(
      `  ${row.accountId}  last ${formatWhen(row.lastRefreshAt)}  next ${formatWhen(row.nextRetryAt)}  lapsed ${row.lapsed ? 'yes' : 'no'}  queued ${queued}  backoff ${row.backoffLevel}`
    )
  }
  console.log(lines.join('\n'))
}

function formatWhen(value: number | null): string {
  if (value === null) {
    return '—'
  }
  return new Date(value).toISOString()
}
