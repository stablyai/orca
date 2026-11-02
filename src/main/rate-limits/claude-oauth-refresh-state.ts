import { createHash } from 'node:crypto'
import { listClaudePaneAccounts } from '../claude-accounts/claude-pane-account-registry'
import type { ClaudeOAuthCredentialReadOptions } from './claude-oauth-credentials'
import type {
  ClaudeOAuthCredentialDocument,
  ClaudeOAuthCredentialStore
} from './claude-oauth-credential-document'
import {
  claudeOAuthRefreshGate,
  claudeOAuthRefreshQueue,
  claudeUsageRefreshAllowed,
  clearClaudeOAuthRefreshRateLimit,
  clearClaudeUsageRefreshSlice,
  planClaudeUsageRefreshSlice,
  resetClaudeOAuthRefreshPacingForTests,
  type ClaudeOAuthRefreshPaceResult
} from './claude-oauth-refresh-pacing'

export type ClaudeOAuthRefreshResult =
  | { outcome: 'refreshed'; accessToken: string }
  | { outcome: 'skipped'; reason: 'disabled' | 'live-session' | 'backoff' | 'no-refresh-token' }
  | { outcome: 'failed'; reason: string }
  | { outcome: 'lapsed' }

export type ClaudeOAuthRefreshAccountStatus = {
  accountId: string
  lastRefreshAt: number | null
  nextRetryAt: number | null
  lapsed: boolean
  queuePosition: number | null
  backoffLevel: number
}

export type PendingWrite = {
  store: ClaudeOAuthCredentialStore
  json: string
  accessToken: string
}

export type AccountBook = {
  lastRefreshAt: number | null
  nextRetryAt: number | null
  failures: number
  backoffLevel: number
  lapsed: boolean
  lapsedHash: string | null
  pending: PendingWrite | null
}

export type ClaudeOAuthRefreshDeps = {
  now: () => number
  fetch: (url: string, init: RequestInit) => Promise<Response>
  readDocument: (
    options: ClaudeOAuthCredentialReadOptions | undefined
  ) => Promise<
    | { ok: true; document: ClaudeOAuthCredentialDocument }
    | { ok: false; reason: 'keychain-unavailable' | 'no-refresh-token' | 'unreadable' }
  >
  writeDocument: (pending: PendingWrite) => Promise<void>
  hasLiveSession: (accountId: string) => boolean
  enabled: () => boolean
  delay: (ms: number) => Promise<void>
  jitterMs: () => number
}

const FIRST_BACKOFF_MS = 5 * 60 * 1000
const NEXT_BACKOFF_MS = 30 * 60 * 1000

const books = new Map<string, AccountBook>()
const inflight = new Map<string, Promise<ClaudeOAuthRefreshResult>>()
let enabledReader: () => boolean = () => true
let cycleId = 0
const claimedCycle = new Map<string, number>()

export function setClaudeOAuthRefreshEnabled(read: () => boolean): void {
  enabledReader = read
}

export function claudeOAuthRefreshIsEnabled(): boolean {
  return enabledReader()
}

export function beginClaudeOAuthRefreshCycle(): void {
  cycleId += 1
  clearClaudeUsageRefreshSlice()
}

export function claudeOAuthRefreshCycleId(): number {
  return cycleId
}

/** One refresh attempt per account for the current inactive-usage cycle. */
export function claimClaudeUsageRefresh(accountId: string): boolean {
  if (claimedCycle.get(accountId) === cycleId) {
    return false
  }
  if (!claudeUsageRefreshAllowed(cycleId, accountId)) {
    return false
  }
  claimedCycle.set(accountId, cycleId)
  return true
}

export function claudeAccountMayRefresh(id: string, now: number, live: boolean): boolean {
  if (live || claudeOAuthRefreshGate(now).active) {
    return false
  }
  const book = books.get(id)
  if (!book) {
    return true
  }
  if (book.lapsed) {
    return false
  }
  return book.nextRetryAt === null || now >= book.nextRetryAt
}

/** Most recently used first. Plans at most three refreshes for this cycle. */
export function orderInactiveClaudeRefreshAccounts<T extends { id: string; recentAt?: number }>(
  accounts: readonly T[],
  active: T | null,
  now = Date.now()
): T[] {
  const liveIds = listClaudePaneAccounts().map((record) => record.accountId)
  const live = new Set(liveIds)
  planClaudeUsageRefreshSlice({
    cycleId,
    accounts: active ? [...accounts, active] : accounts,
    liveIds,
    now,
    mayRefresh: (id, at) => claudeAccountMayRefresh(id, at, live.has(id))
  })
  return [...accounts].sort((a, b) => (b.recentAt ?? 0) - (a.recentAt ?? 0))
}

export function claudeOAuthRefreshStatus(): ClaudeOAuthRefreshAccountStatus[] {
  return claudeOAuthRefreshRows([...books.keys()].map((id) => ({ id, lastAuthenticatedAt: 0 })))
}

export function claudeOAuthRefreshRows(
  accounts: readonly { id: string; lastAuthenticatedAt?: number | null }[]
): ClaudeOAuthRefreshAccountStatus[] {
  const gate = claudeOAuthRefreshGate(Date.now())
  const rows = accounts.map((account) => {
    const book = books.get(account.id)
    return {
      id: account.id,
      recentAt: account.lastAuthenticatedAt ?? 0,
      lapsed: book?.lapsed ?? false,
      lastRefreshAt: book?.lastRefreshAt ?? null,
      nextRetryAt: book?.nextRetryAt ?? null,
      backoffLevel: book?.backoffLevel ?? 0
    }
  })
  const queue = claudeOAuthRefreshQueue(rows)
  return rows.map((row) => ({
    accountId: row.id,
    lastRefreshAt: row.lastRefreshAt,
    nextRetryAt: displayedRetry(row, gate),
    lapsed: row.lapsed,
    queuePosition: queue.get(row.id) ?? null,
    backoffLevel: row.backoffLevel || (queue.has(row.id) && gate.active ? gate.level : 0)
  }))
}

function displayedRetry(
  row: { lapsed: boolean; lastRefreshAt: number | null; nextRetryAt: number | null },
  gate: { active: boolean; until: number }
): number | null {
  const fresh = row.lastRefreshAt !== null && row.nextRetryAt === null
  if (row.lapsed || fresh) {
    return row.nextRetryAt
  }
  if (gate.active && (row.nextRetryAt === null || row.nextRetryAt < gate.until)) {
    return gate.until
  }
  return row.nextRetryAt
}

export function resetClaudeOAuthRefreshStateForTests(): void {
  books.clear()
  inflight.clear()
  claimedCycle.clear()
  cycleId = 0
  enabledReader = () => true
  resetClaudeOAuthRefreshPacingForTests()
}

/** `profile:<id>` and `profile:<id>:wsl:<distro>`. System default keeps its provenance string. */
export function claudeOAuthRefreshAccountId(provenance: string | undefined): string | null {
  if (!provenance || provenance === 'profile:unavailable') {
    return null
  }
  if (provenance.startsWith('profile:')) {
    const rest = provenance.slice('profile:'.length)
    const wslAt = rest.indexOf(':wsl:')
    const accountId = wslAt === -1 ? rest : rest.slice(0, wslAt)
    return accountId && accountId !== 'unavailable' ? accountId : null
  }
  if (provenance === 'system' || provenance.startsWith('wsl:')) {
    return provenance
  }
  return null
}

export function claudeOAuthRefreshInflight(
  accountId: string,
  start: () => Promise<ClaudeOAuthRefreshResult>
): Promise<ClaudeOAuthRefreshResult> {
  const existing = inflight.get(accountId)
  if (existing) {
    return existing
  }
  const run = start().finally(() => {
    if (inflight.get(accountId) === run) {
      inflight.delete(accountId)
    }
  })
  inflight.set(accountId, run)
  return run
}

export function claudeOAuthRefreshBook(accountId: string): AccountBook {
  const existing = books.get(accountId)
  if (existing) {
    return existing
  }
  const created: AccountBook = {
    lastRefreshAt: null,
    nextRetryAt: null,
    failures: 0,
    backoffLevel: 0,
    lapsed: false,
    lapsedHash: null,
    pending: null
  }
  books.set(accountId, created)
  return created
}

export function noteClaudeOAuthRefreshFailure(book: AccountBook, now: number): void {
  book.failures += 1
  book.backoffLevel = book.failures <= 1 ? 1 : 2
  book.nextRetryAt = now + (book.failures <= 1 ? FIRST_BACKOFF_MS : NEXT_BACKOFF_MS)
}

export function noteClaudeOAuthRefreshGate(
  book: AccountBook,
  gate: { until: number; level: number }
): ClaudeOAuthRefreshResult {
  book.nextRetryAt = gate.until
  book.backoffLevel = gate.level
  book.failures = gate.level
  return { outcome: 'skipped', reason: 'backoff' }
}

export function noteClaudeOAuthRefreshPace(
  accountId: string,
  book: AccountBook,
  now: number,
  paced: Exclude<ClaudeOAuthRefreshPaceResult, { outcome: 'posted' }>
): ClaudeOAuthRefreshResult {
  if (paced.outcome === 'network') {
    noteClaudeOAuthRefreshFailure(book, now)
    logClaudeOAuthRefresh(accountId, 'failed=network')
    return { outcome: 'failed', reason: 'network' }
  }
  book.nextRetryAt = paced.until
  book.backoffLevel = paced.level
  book.failures = paced.level
  if (paced.outcome === 'limited') {
    logClaudeOAuthRefresh(accountId, 'failed=http-429')
    return { outcome: 'failed', reason: 'http-429' }
  }
  return { outcome: 'skipped', reason: 'backoff' }
}

export function noteClaudeOAuthRefreshSuccess(book: AccountBook, now: number): void {
  book.failures = 0
  book.backoffLevel = 0
  book.nextRetryAt = null
  book.lapsed = false
  book.lapsedHash = null
  book.lastRefreshAt = now
  clearClaudeOAuthRefreshRateLimit()
}

export function logClaudeOAuthRefresh(accountId: string, outcome: 'ok' | `failed=${string}`): void {
  console.info(`[claude-usage] refresh account=${accountId} ${outcome}`)
}

export function hashClaudeOAuthRefreshToken(refreshToken: string): string {
  return createHash('sha256').update(refreshToken).digest('hex')
}
