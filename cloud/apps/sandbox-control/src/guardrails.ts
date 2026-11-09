// Cost guardrails in front of every start (create, resume, rollover): the operator kill switch, a
// global running cap, a per-account concurrency backstop (billing enforces the plan limit too) and a
// per-account create rate limit. All are control-plane local, so a billing outage cannot lift them.
import { ACTIVE_STATUSES } from './store'

export type GuardrailConfig = {
  /** Static kill switch from the deploy config (`SANDBOX_CREATES_DISABLED=true`). */
  startsDisabled: boolean
  maxRunning: number
  maxActivePerSeat: number
  createsPerMinute: number
}

export const DEFAULT_GUARDRAILS: GuardrailConfig = {
  startsDisabled: false,
  maxRunning: 50,
  maxActivePerSeat: 3,
  createsPerMinute: 10
}

export class GuardrailError extends Error {
  constructor(
    readonly code: 'maintenance' | 'capacity' | 'rate_limited' | 'concurrency_limit',
    readonly retryAfterSeconds?: number
  ) {
    super(code)
    this.name = 'GuardrailError'
  }
}

const KILL_SWITCH = 'kill_switch'

export async function getControlState(db: D1Database, name: string): Promise<string | null> {
  const row = await db.prepare('SELECT value FROM control_state WHERE name = ?').bind(name).first<{ value: string }>()
  return row?.value ?? null
}

export async function setControlState(db: D1Database, name: string, value: string, now: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO control_state (name, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    )
    .bind(name, value, now)
    .run()
}

export async function killSwitchOn(db: D1Database, config: GuardrailConfig): Promise<boolean> {
  return config.startsDisabled || (await getControlState(db, KILL_SWITCH)) === 'on'
}

export function setKillSwitch(db: D1Database, on: boolean, now: number): Promise<void> {
  return setControlState(db, KILL_SWITCH, on ? 'on' : 'off', now)
}

async function countActive(db: D1Database, accountId?: string): Promise<number> {
  const placeholders = ACTIVE_STATUSES.map(() => '?').join(', ')
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM sandboxes WHERE status IN (${placeholders}) ${accountId ? 'AND account_id = ?' : ''}`
    )
    .bind(...ACTIVE_STATUSES, ...(accountId ? [accountId] : []))
    .first<{ n: number }>()
  return row?.n ?? 0
}

export function countAllActive(db: D1Database): Promise<number> {
  return countActive(db)
}

/** Kill switch + global running cap; checked before billing is asked anything. */
export async function assertStartsOpen(db: D1Database, config: GuardrailConfig): Promise<void> {
  if (await killSwitchOn(db, config)) {
    throw new GuardrailError('maintenance')
  }
  if ((await countAllActive(db)) >= config.maxRunning) {
    console.log(JSON.stringify({ event: 'global_cap_reached', maxRunning: config.maxRunning }))
    throw new GuardrailError('capacity', 60)
  }
}

/** Per-account backstop: billing's `maxConcurrentSandboxes` when it sends one, else 3 per seat (seats default 1). */
export async function assertAccountCapacity(
  db: D1Database,
  config: GuardrailConfig,
  accountId: string,
  limits: { seats?: number; maxConcurrentSandboxes?: number } = {}
): Promise<void> {
  const cap = limits.maxConcurrentSandboxes ?? config.maxActivePerSeat * Math.max(1, Math.floor(limits.seats ?? 1))
  if ((await countActive(db, accountId)) >= cap) {
    throw new GuardrailError('concurrency_limit')
  }
}

/** Fixed one-minute window per account; counts every create request, retries included. */
export async function consumeCreateToken(db: D1Database, config: GuardrailConfig, accountId: string, now: number) {
  const windowStart = now - (now % 60_000)
  const bucket = `create:${accountId}`
  await db
    .prepare(
      `INSERT INTO rate_windows (bucket, window_start, count) VALUES (?, ?, 1)
       ON CONFLICT (bucket) DO UPDATE SET
         count = CASE WHEN rate_windows.window_start = excluded.window_start THEN rate_windows.count + 1 ELSE 1 END,
         window_start = excluded.window_start`
    )
    .bind(bucket, windowStart)
    .run()
  const row = await db.prepare('SELECT count FROM rate_windows WHERE bucket = ?').bind(bucket).first<{ count: number }>()
  if ((row?.count ?? 0) > config.createsPerMinute) {
    throw new GuardrailError('rate_limited', Math.ceil((windowStart + 60_000 - now) / 1000))
  }
}

export function guardrailsFromEnv(env: {
  SANDBOX_CREATES_DISABLED?: string
  SANDBOX_MAX_RUNNING?: string
  ACCOUNT_MAX_ACTIVE_PER_SEAT?: string
  CREATE_RATE_PER_MINUTE?: string
}): GuardrailConfig {
  const int = (value: string | undefined, fallback: number) => {
    const parsed = Number(value)
    return value !== undefined && Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback
  }
  return {
    startsDisabled: env.SANDBOX_CREATES_DISABLED === 'true',
    maxRunning: int(env.SANDBOX_MAX_RUNNING, DEFAULT_GUARDRAILS.maxRunning),
    maxActivePerSeat: int(env.ACCOUNT_MAX_ACTIVE_PER_SEAT, DEFAULT_GUARDRAILS.maxActivePerSeat),
    createsPerMinute: int(env.CREATE_RATE_PER_MINUTE, DEFAULT_GUARDRAILS.createsPerMinute)
  }
}
