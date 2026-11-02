/** One token POST at a time. The endpoint rate-limits a burst from one client. */
export const CLAUDE_OAUTH_REFRESH_MIN_GAP_MS = 3_000
export const CLAUDE_OAUTH_REFRESH_JITTER_MS = 1_000
export const CLAUDE_OAUTH_REFRESHES_PER_CYCLE = 3

const MAX_RETRY_AFTER_MS = 30 * 60 * 1000
const LADDER_MS = [60_000, 5 * 60 * 1000, 30 * 60 * 1000] as const

export type ClaudeOAuthRefreshPaceResult =
  | { outcome: 'posted'; response: Response }
  | { outcome: 'backoff'; until: number; level: number }
  | { outcome: 'limited'; until: number; level: number }
  | { outcome: 'network' }

type PaceInput = {
  now: () => number
  delay: (ms: number) => Promise<void>
  jitterMs: () => number
  force: boolean
  post: () => Promise<Response>
}

type QueueAccount = {
  id: string
  recentAt: number
  lapsed: boolean
  lastRefreshAt: number | null
  nextRetryAt: number | null
}

let tail: Promise<void> = Promise.resolve()
let lastPostFinishedAt = 0
let strike = 0
let gateUntil = 0
let armed = true
let rotationAfterId: string | null = null
let allowance: Set<string> | null = null
let plannedCycle = -1

export function resetClaudeOAuthRefreshPacingForTests(): void {
  tail = Promise.resolve()
  lastPostFinishedAt = 0
  strike = 0
  gateUntil = 0
  armed = true
  rotationAfterId = null
  allowance = null
  plannedCycle = -1
}

export function clearClaudeOAuthRefreshRateLimit(): void {
  strike = 0
  gateUntil = 0
  armed = true
}

export function clearClaudeUsageRefreshSlice(): void {
  allowance = null
  plannedCycle = -1
}

export function claudeOAuthRefreshGate(now: number): {
  active: boolean
  until: number
  level: number
} {
  return { active: now < gateUntil, until: gateUntil, level: strike }
}

export function claudeUsageRefreshAllowed(cycle: number, accountId: string): boolean {
  if (plannedCycle !== cycle || allowance === null) {
    return true
  }
  return allowance.has(accountId)
}

export function paceClaudeOAuthRefreshPost(
  input: PaceInput
): Promise<ClaudeOAuthRefreshPaceResult> {
  const run = tail.then(() => runLocked(input))
  tail = run.then(
    () => undefined,
    () => undefined
  )
  return run
}

async function runLocked(input: PaceInput): Promise<ClaudeOAuthRefreshPaceResult> {
  const now = input.now()
  if (!input.force && now < gateUntil) {
    return { outcome: 'backoff', until: gateUntil, level: strike }
  }
  const wait = gapWait(now, clampJitter(input.jitterMs()))
  if (wait > 0) {
    await input.delay(wait)
  }
  if (input.now() >= gateUntil) {
    armed = true
  }
  try {
    const response = await input.post()
    lastPostFinishedAt = input.now()
    if (response.status !== 429) {
      return { outcome: 'posted', response }
    }
    apply429(
      lastPostFinishedAt,
      retryAfterMs(response.headers.get('retry-after'), lastPostFinishedAt)
    )
    return { outcome: 'limited', until: gateUntil, level: strike }
  } catch {
    lastPostFinishedAt = input.now()
    return { outcome: 'network' }
  }
}

function gapWait(now: number, jitter: number): number {
  if (lastPostFinishedAt === 0) {
    return 0
  }
  return Math.max(0, lastPostFinishedAt + CLAUDE_OAUTH_REFRESH_MIN_GAP_MS + jitter - now)
}

function clampJitter(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0
  }
  return Math.min(value, CLAUDE_OAUTH_REFRESH_JITTER_MS)
}

function apply429(now: number, retryAfter: number | null): void {
  if (armed) {
    strike = Math.min(strike + 1, LADDER_MS.length)
    armed = false
  } else if (strike === 0) {
    strike = 1
    armed = false
  }
  const step = LADDER_MS[Math.max(0, strike - 1)] ?? LADDER_MS.at(-1)
  gateUntil = now + (retryAfter ?? step)
}

function retryAfterMs(header: string | null, now: number): number | null {
  const trimmed = header?.trim() ?? ''
  if (!trimmed) {
    return null
  }
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    return Math.min(Number(trimmed) * 1000, MAX_RETRY_AFTER_MS)
  }
  const date = Date.parse(trimmed)
  if (Number.isNaN(date)) {
    return null
  }
  return Math.min(Math.max(0, date - now), MAX_RETRY_AFTER_MS)
}

export function planClaudeUsageRefreshSlice(input: {
  cycleId: number
  accounts: readonly { id: string; recentAt?: number }[]
  liveIds: readonly string[]
  now: number
  mayRefresh: (id: string, now: number) => boolean
}): string[] {
  if (input.now < gateUntil) {
    allowance = new Set()
    plannedCycle = input.cycleId
    return []
  }
  const live = new Set(input.liveIds)
  const ranked = input.accounts
    .map((account, index) => ({ id: account.id, recentAt: account.recentAt ?? 0, index }))
    .sort((a, b) => b.recentAt - a.recentAt || a.index - b.index)
  const start = rotationStart(ranked)
  const chosen: string[] = []
  for (
    let step = 0;
    step < ranked.length && chosen.length < CLAUDE_OAUTH_REFRESHES_PER_CYCLE;
    step += 1
  ) {
    const account = ranked[(start + step) % ranked.length]
    if (!account || chosen.includes(account.id) || live.has(account.id)) {
      continue
    }
    if (!input.mayRefresh(account.id, input.now)) {
      continue
    }
    chosen.push(account.id)
  }
  if (chosen.length > 0) {
    rotationAfterId = chosen.at(-1) ?? null
  }
  allowance = new Set(chosen)
  plannedCycle = input.cycleId
  return chosen
}

function rotationStart(ranked: readonly { id: string }[]): number {
  if (!rotationAfterId) {
    return 0
  }
  const at = ranked.findIndex((row) => row.id === rotationAfterId)
  if (at === -1) {
    return 0
  }
  return (at + 1) % ranked.length
}

export function claudeOAuthRefreshQueue(accounts: readonly QueueAccount[]): Map<string, number> {
  const ranked = accounts
    .map((account, index) => ({ account, index }))
    .sort((a, b) => b.account.recentAt - a.account.recentAt || a.index - b.index)
    .map((row) => row.account)
  const start = rotationStart(ranked)
  const queue = new Map<string, number>()
  for (let step = 0; step < ranked.length; step += 1) {
    const account = ranked[(start + step) % ranked.length]
    if (!account || queue.has(account.id) || !isWaiting(account)) {
      continue
    }
    queue.set(account.id, queue.size + 1)
  }
  return queue
}

function isWaiting(account: QueueAccount): boolean {
  if (account.lapsed) {
    return false
  }
  return !(account.lastRefreshAt !== null && account.nextRetryAt === null)
}
