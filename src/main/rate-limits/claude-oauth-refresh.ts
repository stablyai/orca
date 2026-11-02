import { listClaudePaneAccounts } from '../claude-accounts/claude-pane-account-registry'
import { writeCredentialFileAtomic } from '../credentials/integration-credential-file'
import { execSecurityCommand } from '../macos-keychain/generic-password'
import { CLAUDE_OAUTH_TOKEN_HEADERS, claudeOAuthTokenFetch } from './claude-oauth-node-fetch'
import {
  asClaudeOAuthRecord,
  claudeOAuthStringField,
  readClaudeOAuthCredentialDocument,
  type ClaudeOAuthCredentialDocument
} from './claude-oauth-credential-document'
import type { ClaudeOAuthCredentialReadOptions } from './claude-oauth-credentials'
import { scopesToSend } from './claude-oauth-refresh-scopes'
import {
  CLAUDE_OAUTH_REFRESH_JITTER_MS,
  claudeOAuthRefreshGate,
  paceClaudeOAuthRefreshPost
} from './claude-oauth-refresh-pacing'
import {
  claudeOAuthRefreshBook,
  claudeOAuthRefreshInflight,
  claudeOAuthRefreshIsEnabled,
  hashClaudeOAuthRefreshToken,
  logClaudeOAuthRefresh,
  noteClaudeOAuthRefreshFailure,
  noteClaudeOAuthRefreshGate,
  noteClaudeOAuthRefreshPace,
  noteClaudeOAuthRefreshSuccess,
  type AccountBook,
  type ClaudeOAuthRefreshDeps,
  type ClaudeOAuthRefreshResult,
  type PendingWrite
} from './claude-oauth-refresh-state'
import path from 'node:path'

export {
  beginClaudeOAuthRefreshCycle,
  claimClaudeUsageRefresh,
  claudeOAuthRefreshAccountId,
  claudeOAuthRefreshStatus,
  resetClaudeOAuthRefreshStateForTests,
  setClaudeOAuthRefreshEnabled
} from './claude-oauth-refresh-state'
export { readClaudeOAuthCredentialDocument } from './claude-oauth-credential-document'
export { CLAUDE_OAUTH_DEFAULT_SCOPES } from './claude-oauth-refresh-scopes'

/** Claude Code 2.1.314 `Pae` posts here via axios 1.15.2 node http. Timeout is 30s. */
export const CLAUDE_OAUTH_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token'
/** Claude Code `CLIENT_ID`. Not the design client. */
export const CLAUDE_CODE_OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'

const TOKEN_TIMEOUT_MS = 30_000

export function refreshClaudeOAuthAccessToken(input: {
  accountId: string
  readOptions?: ClaudeOAuthCredentialReadOptions
  force?: boolean
  deps?: Partial<ClaudeOAuthRefreshDeps>
}): Promise<ClaudeOAuthRefreshResult> {
  return claudeOAuthRefreshInflight(input.accountId, () => refreshOne(input))
}

async function refreshOne(input: {
  accountId: string
  readOptions?: ClaudeOAuthCredentialReadOptions
  force?: boolean
  deps?: Partial<ClaudeOAuthRefreshDeps>
}): Promise<ClaudeOAuthRefreshResult> {
  const deps = resolveDeps(input.deps)
  const book = claudeOAuthRefreshBook(input.accountId)
  if (book.pending) {
    return finishPendingWrite(input.accountId, book, deps)
  }
  if (!deps.enabled()) {
    return { outcome: 'skipped', reason: 'disabled' }
  }
  if (deps.hasLiveSession(input.accountId)) {
    return { outcome: 'skipped', reason: 'live-session' }
  }
  const read = await deps.readDocument(input.readOptions)
  if (!read.ok) {
    if (read.reason === 'no-refresh-token') {
      return { outcome: 'skipped', reason: 'no-refresh-token' }
    }
    logClaudeOAuthRefresh(input.accountId, `failed=${read.reason}`)
    return { outcome: 'failed', reason: read.reason }
  }
  const hash = hashClaudeOAuthRefreshToken(read.document.refreshToken)
  if (book.lapsed && book.lapsedHash === hash) {
    return { outcome: 'lapsed' }
  }
  if (book.lapsed) {
    book.lapsed = false
    book.lapsedHash = null
    book.failures = 0
    book.backoffLevel = 0
    book.nextRetryAt = null
  }
  const now = deps.now()
  if (!input.force && book.nextRetryAt !== null && now < book.nextRetryAt) {
    return { outcome: 'skipped', reason: 'backoff' }
  }
  const gate = claudeOAuthRefreshGate(now)
  if (!input.force && gate.active) {
    return noteClaudeOAuthRefreshGate(book, gate)
  }
  const paced = await paceClaudeOAuthRefreshPost({
    now: deps.now,
    delay: deps.delay,
    jitterMs: deps.jitterMs,
    force: input.force === true,
    post: () =>
      deps.fetch(CLAUDE_OAUTH_TOKEN_URL, {
        method: 'POST',
        headers: { ...CLAUDE_OAUTH_TOKEN_HEADERS },
        body: JSON.stringify(tokenRequestBody(read.document.oauth)),
        redirect: 'manual',
        signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS)
      })
  })
  if (paced.outcome !== 'posted') {
    return noteClaudeOAuthRefreshPace(input.accountId, book, now, paced)
  }
  const response = paced.response
  if (!response.ok) {
    const invalidGrant = await invalidGrantResponse(response)
    if (invalidGrant) {
      book.lapsed = true
      book.lapsedHash = hash
      book.nextRetryAt = null
      book.failures = 0
      book.backoffLevel = 0
      logClaudeOAuthRefresh(input.accountId, 'failed=lapsed')
      return { outcome: 'lapsed' }
    }
    noteClaudeOAuthRefreshFailure(book, now)
    const reason = `http-${response.status}`
    logClaudeOAuthRefresh(input.accountId, `failed=${reason}`)
    return { outcome: 'failed', reason }
  }
  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    noteClaudeOAuthRefreshFailure(book, now)
    logClaudeOAuthRefresh(input.accountId, 'failed=malformed')
    return { outcome: 'failed', reason: 'malformed' }
  }
  const accessToken = applyTokenResponse(read.document, payload, now)
  if (!accessToken) {
    noteClaudeOAuthRefreshFailure(book, now)
    logClaudeOAuthRefresh(input.accountId, 'failed=malformed')
    return { outcome: 'failed', reason: 'malformed' }
  }
  const pending: PendingWrite = {
    store: read.document.store,
    json: JSON.stringify(read.document.parsed),
    accessToken
  }
  try {
    await deps.writeDocument(pending)
  } catch {
    book.pending = pending
    logClaudeOAuthRefresh(input.accountId, 'failed=write-failed')
    return { outcome: 'failed', reason: 'write-failed' }
  }
  noteClaudeOAuthRefreshSuccess(book, now)
  logClaudeOAuthRefresh(input.accountId, 'ok')
  return { outcome: 'refreshed', accessToken }
}

async function finishPendingWrite(
  accountId: string,
  book: AccountBook,
  deps: ClaudeOAuthRefreshDeps
): Promise<ClaudeOAuthRefreshResult> {
  const pending = book.pending
  if (!pending) {
    return { outcome: 'failed', reason: 'write-failed' }
  }
  try {
    await deps.writeDocument(pending)
  } catch {
    logClaudeOAuthRefresh(accountId, 'failed=write-failed')
    return { outcome: 'failed', reason: 'write-failed' }
  }
  book.pending = null
  noteClaudeOAuthRefreshSuccess(book, deps.now())
  logClaudeOAuthRefresh(accountId, 'ok')
  return { outcome: 'refreshed', accessToken: pending.accessToken }
}

function resolveDeps(partial: Partial<ClaudeOAuthRefreshDeps> | undefined): ClaudeOAuthRefreshDeps {
  return {
    now: partial?.now ?? Date.now,
    fetch: partial?.fetch ?? claudeOAuthTokenFetch,
    readDocument: partial?.readDocument ?? readClaudeOAuthCredentialDocument,
    writeDocument: partial?.writeDocument ?? writeClaudeOAuthCredentialDocument,
    hasLiveSession:
      partial?.hasLiveSession ??
      ((accountId) => listClaudePaneAccounts().some((record) => record.accountId === accountId)),
    enabled: partial?.enabled ?? claudeOAuthRefreshIsEnabled,
    delay: partial?.delay ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    jitterMs:
      partial?.jitterMs ?? (() => Math.floor(Math.random() * (CLAUDE_OAUTH_REFRESH_JITTER_MS + 1)))
  }
}

function tokenRequestBody(oauth: Record<string, unknown>): {
  grant_type: 'refresh_token'
  refresh_token: string
  client_id: string
  scope: string
} {
  const refreshToken = typeof oauth.refreshToken === 'string' ? oauth.refreshToken : ''
  const clientId =
    typeof oauth.clientId === 'string' && oauth.clientId
      ? oauth.clientId
      : CLAUDE_CODE_OAUTH_CLIENT_ID
  return {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
    scope: scopesToSend(oauth).join(' ')
  }
}

function applyTokenResponse(
  document: ClaudeOAuthCredentialDocument,
  payload: unknown,
  now: number
): string | null {
  const body = asClaudeOAuthRecord(payload)
  const accessToken = typeof body?.access_token === 'string' ? body.access_token : ''
  const expiresIn = typeof body?.expires_in === 'number' ? body.expires_in : null
  if (!accessToken || expiresIn === null || !Number.isFinite(expiresIn)) {
    return null
  }
  const oauth = document.oauth
  oauth.accessToken = accessToken
  oauth.expiresAt = now + expiresIn * 1000
  if (typeof body?.refresh_token === 'string' && body.refresh_token) {
    oauth.refreshToken = body.refresh_token
    document.refreshToken = body.refresh_token
  }
  if (
    typeof body?.refresh_token_expires_in === 'number' &&
    Number.isFinite(body.refresh_token_expires_in)
  ) {
    oauth.refreshTokenExpiresAt = now + body.refresh_token_expires_in * 1000
  }
  if (typeof body?.scope === 'string' && body.scope.trim()) {
    oauth.scopes = body.scope.split(' ').filter(Boolean)
  }
  const subscription =
    claudeOAuthStringField(body, 'subscriptionType') ??
    claudeOAuthStringField(body, 'subscription_type')
  if (subscription) {
    oauth.subscriptionType = subscription
  }
  const tier =
    claudeOAuthStringField(body, 'rateLimitTier') ?? claudeOAuthStringField(body, 'rate_limit_tier')
  if (tier) {
    oauth.rateLimitTier = tier
  }
  const clientId = claudeOAuthStringField(body, 'client_id')
  if (clientId) {
    oauth.clientId = clientId
  }
  return accessToken
}

async function invalidGrantResponse(response: Response): Promise<boolean> {
  let body: unknown = null
  try {
    body = await response.json()
  } catch {
    try {
      await response.text()
    } catch {
      body = null
    }
  }
  if (response.status !== 400 && response.status !== 401) {
    return false
  }
  const record = asClaudeOAuthRecord(body)
  return record?.error === 'invalid_grant' || record?.code === 'invalid_grant'
}

async function writeClaudeOAuthCredentialDocument(pending: PendingWrite): Promise<void> {
  if (pending.store.kind === 'keychain') {
    await execSecurityCommand([
      'add-generic-password',
      '-U',
      '-s',
      pending.store.service,
      '-a',
      pending.store.account,
      '-w',
      pending.json
    ])
    return
  }
  if (
    !writeCredentialFileAtomic(
      path.join(path.dirname(pending.store.path), '.credentials.json'),
      Buffer.from(pending.json, 'utf8')
    )
  ) {
    throw new Error('Claude credential file was not published')
  }
}
