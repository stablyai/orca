// Host-local tracking of usage-limited (agent, account, model) tuples with reset timers and usage checks.
import type { BotAgent } from '../../shared/bot-types'
import { usageLimitResetsAt } from '../../shared/agent-session/failures/agent-session-usage-limit'

export const BOT_USAGE_LIMIT_RESET_GRACE_MS = 15_000
export const BOT_USAGE_LIMIT_UNKNOWN_RECHECK_MS = 15 * 60_000
const MAX_TIMER_MS = 2_147_483_647

export type BotUsageLimitKey = {
  agent: BotAgent
  /** Host-internal canonical account home key; never serialized or sent to clients. */
  accountHomeKey: string
  /** Normalized model id, or empty string for the agent's default model. */
  model: string
}

export type BotUsageLimitGateDeps = {
  now?: () => number
  /** Returns epoch ms until spent (null if spent with unknown reset), or undefined when room exists. */
  readSpentUntil?: (
    key: BotUsageLimitKey
  ) => Promise<number | null | undefined> | number | null | undefined
  onLimitReleased?: (key: BotUsageLimitKey) => void
  onLimitChanged?: () => void
}

type HeldLimit = {
  key: BotUsageLimitKey
  resetsAt: number | null
  timer: ReturnType<typeof setTimeout> | null
}

function serializeKey(key: BotUsageLimitKey): string {
  return `${key.agent}\u0000${key.accountHomeKey}\u0000${key.model}`
}

export class BotUsageLimitGate {
  private readonly holds = new Map<string, HeldLimit>()
  private readonly now: () => number
  private disposed = false

  constructor(private readonly deps: BotUsageLimitGateDeps = {}) {
    this.now = deps.now ?? Date.now
  }

  recordLimit(input: BotUsageLimitKey & { resetsAt?: number }): void {
    if (this.disposed) {
      return
    }
    const id = serializeKey(input)
    const now = this.now()
    const validReset =
      input.resetsAt === undefined ? null : (usageLimitResetsAt(input.resetsAt, now) ?? null)
    const existing = this.holds.get(id)
    if (existing?.timer) {
      clearTimeout(existing.timer)
    }
    const nextResetsAt =
      validReset !== null && validReset > now
        ? Math.max(validReset, existing?.resetsAt ?? 0)
        : existing?.resetsAt && existing.resetsAt > now
          ? existing.resetsAt
          : null
    const held: HeldLimit = {
      key: { agent: input.agent, accountHomeKey: input.accountHomeKey, model: input.model },
      resetsAt: nextResetsAt,
      timer: null
    }
    this.holds.set(id, held)
    this.arm(id, held)
    this.deps.onLimitChanged?.()
  }

  recordSuccess(key: BotUsageLimitKey): void {
    const id = serializeKey(key)
    const held = this.holds.get(id)
    if (!held) {
      return
    }
    if (held.timer) {
      clearTimeout(held.timer)
    }
    this.holds.delete(id)
    this.deps.onLimitChanged?.()
    this.deps.onLimitReleased?.(held.key)
  }

  clearAccount(agent: BotAgent, accountHomeKey?: string): void {
    const released: BotUsageLimitKey[] = []
    for (const [id, held] of this.holds.entries()) {
      if (
        held.key.agent === agent &&
        (accountHomeKey === undefined || held.key.accountHomeKey === accountHomeKey)
      ) {
        if (held.timer) {
          clearTimeout(held.timer)
        }
        this.holds.delete(id)
        released.push(held.key)
      }
    }
    if (released.length > 0) {
      this.deps.onLimitChanged?.()
      for (const key of released) {
        this.deps.onLimitReleased?.(key)
      }
    }
  }

  isLimited(key: BotUsageLimitKey): boolean {
    const held = this.holds.get(serializeKey(key))
    if (!held) {
      return false
    }
    if (held.resetsAt !== null && held.resetsAt + BOT_USAGE_LIMIT_RESET_GRACE_MS <= this.now()) {
      return false
    }
    return true
  }

  limitResetAt(key: BotUsageLimitKey): number | undefined {
    const held = this.holds.get(serializeKey(key))
    if (!held || held.resetsAt === null) {
      return undefined
    }
    return held.resetsAt > this.now() ? held.resetsAt : undefined
  }

  earliestResetAt(keys: readonly BotUsageLimitKey[]): number | undefined {
    let earliest: number | undefined
    for (const key of keys) {
      const reset = this.limitResetAt(key)
      if (reset !== undefined && (earliest === undefined || reset < earliest)) {
        earliest = reset
      }
    }
    return earliest
  }

  /** Confirms whether `key` is ready to resume (checks timer + live usage reading when available). */
  async verifyReturnReady(key: BotUsageLimitKey): Promise<boolean> {
    if (this.disposed) {
      return false
    }
    if (this.isLimited(key)) {
      return false
    }
    if (!this.deps.readSpentUntil) {
      return true
    }
    try {
      const spentUntil = await this.deps.readSpentUntil(key)
      if (this.disposed || this.isLimited(key)) {
        return false
      }
      if (spentUntil === undefined) {
        return true
      }
      if (
        typeof spentUntil === 'number' &&
        spentUntil + BOT_USAGE_LIMIT_RESET_GRACE_MS <= this.now()
      ) {
        return true
      }
      this.recordLimit({
        ...key,
        ...(typeof spentUntil === 'number' ? { resetsAt: spentUntil } : {})
      })
      return false
    } catch {
      return !this.disposed && !this.isLimited(key)
    }
  }

  dispose(): void {
    this.disposed = true
    for (const held of this.holds.values()) {
      if (held.timer) {
        clearTimeout(held.timer)
      }
    }
    this.holds.clear()
  }

  private arm(id: string, held: HeldLimit): void {
    if (this.disposed) {
      return
    }
    const now = this.now()
    const rawDelay =
      held.resetsAt !== null
        ? Math.max(0, held.resetsAt + BOT_USAGE_LIMIT_RESET_GRACE_MS - now)
        : BOT_USAGE_LIMIT_UNKNOWN_RECHECK_MS
    const delay = Math.min(rawDelay, MAX_TIMER_MS)
    held.timer = setTimeout(() => {
      void this.onTimer(id, held)
    }, delay)
    held.timer.unref?.()
  }

  private async onTimer(id: string, held: HeldLimit): Promise<void> {
    if (this.disposed || this.holds.get(id) !== held) {
      return
    }
    held.timer = null
    if (held.resetsAt !== null && held.resetsAt + BOT_USAGE_LIMIT_RESET_GRACE_MS > this.now()) {
      this.arm(id, held)
      return
    }
    if (this.deps.readSpentUntil) {
      try {
        const spentUntil = await this.deps.readSpentUntil(held.key)
        if (this.disposed || this.holds.get(id) !== held) {
          return
        }
        if (spentUntil !== undefined) {
          // Only re-arm when the reported window is still active; an already-expired reset falls through to release.
          if (spentUntil === null || spentUntil + BOT_USAGE_LIMIT_RESET_GRACE_MS > this.now()) {
            held.resetsAt = typeof spentUntil === 'number' ? spentUntil : null
            this.arm(id, held)
            this.deps.onLimitChanged?.()
            return
          }
        }
      } catch {
        // Unreadable usage falls through to release once the known reset window has elapsed.
      }
    }
    if (this.disposed || this.holds.get(id) !== held) {
      return
    }
    this.holds.delete(id)
    this.deps.onLimitChanged?.()
    this.deps.onLimitReleased?.(held.key)
  }
}
