import { z } from 'zod'
import type { CodexManagedAccount } from '../../shared/managed-account-types'
import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import { codexQuotaAvailability } from './codex-automation-policy'
import { CODEX_WARMING_STATUSES } from '../../shared/codex-account-automation-state'

const deadlineSchema = z.object({ session: z.number().nullable(), weekly: z.number().nullable() })
const accountStateSchema = z.object({
  deadlines: deadlineSchema,
  attempted: deadlineSchema,
  status: z.enum(CODEX_WARMING_STATUSES),
  updatedAt: z.number()
})
export const codexWarmingStateSchema = z.record(z.string(), accountStateSchema)
export type CodexWarmingState = z.infer<typeof codexWarmingStateSchema>
type AccountState = z.infer<typeof accountStateSchema>
const WINDOWS = ['session', 'weekly'] as const

export type CodexResetWarmingDependencies = {
  accounts: () => readonly CodexManagedAccount[]
  enabled: () => boolean
  busy: (account: CodexManagedAccount) => boolean
  readUsage: (
    account: CodexManagedAccount,
    signal: AbortSignal
  ) => Promise<ProviderRateLimits | null>
  warm: (
    account: CodexManagedAccount,
    signal: AbortSignal,
    beforeSubmit: () => Promise<void>
  ) => Promise<boolean>
  save: (state: CodexWarmingState) => Promise<void>
  now?: () => number
}

export class CodexResetWarming {
  private inFlight: Promise<void> | null = null
  private controller = new AbortController()
  private stopped = false

  constructor(
    private state: CodexWarmingState,
    private readonly deps: CodexResetWarmingDependencies
  ) {}

  snapshot(): CodexWarmingState {
    return structuredClone(this.state)
  }

  cancel(): void {
    this.controller.abort()
    this.controller = new AbortController()
  }

  drain(): Promise<void> {
    return this.inFlight ?? Promise.resolve()
  }

  stop(): void {
    this.stopped = true
    this.cancel()
  }

  tick(): Promise<void> {
    if (this.inFlight) {
      return this.inFlight
    }
    this.inFlight = this.run(this.controller.signal).finally(() => {
      this.inFlight = null
    })
    return this.inFlight
  }

  private current(account: CodexManagedAccount, signal: AbortSignal): boolean {
    return (
      !this.stopped &&
      !signal.aborted &&
      this.deps.enabled() &&
      this.deps
        .accounts()
        .some(
          (entry) => entry.id === account.id && entry.managedHomePath === account.managedHomePath
        )
    )
  }

  private async run(signal: AbortSignal): Promise<void> {
    if (this.stopped || !this.deps.enabled()) {
      return
    }
    const accounts = this.deps.accounts()
    const ids = new Set(accounts.map((account) => account.id))
    for (const id of Object.keys(this.state)) {
      if (!ids.has(id)) {
        delete this.state[id]
      }
    }
    for (const account of accounts) {
      if (!this.current(account, signal)) {
        continue
      }
      try {
        await this.visit(account, signal)
      } catch {
        // A failed durable write or ambiguous provider result must never cause a replay.
        const entry = this.state[account.id]
        if (entry) {
          entry.status = entry.status === 'attempting' ? 'unconfirmed' : 'unavailable'
        }
      }
    }
    await this.deps.save(this.snapshot())
  }

  private async visit(account: CodexManagedAccount, signal: AbortSignal): Promise<void> {
    const now = this.deps.now?.() ?? Date.now()
    const entry: AccountState = this.state[account.id] ?? {
      deadlines: { session: null, weekly: null },
      attempted: { session: null, weekly: null },
      status: 'waiting',
      updatedAt: now
    }
    this.state[account.id] = entry
    const usage = await this.deps.readUsage(account, signal)
    if (!this.current(account, signal)) {
      return
    }
    if (!usage || usage.status !== 'ok' || usage.error) {
      entry.status = 'unavailable'
      return
    }
    // Preserve the earliest unattempted deadline when an unused window keeps sliding forward.
    for (const kind of WINDOWS) {
      const observed = usage[kind]?.resetsAt
      if (
        observed != null &&
        Number.isFinite(observed) &&
        observed > 0 &&
        (entry.deadlines[kind] === null ||
          (entry.attempted[kind] === entry.deadlines[kind] &&
            (usage[kind]?.usedPercent ?? 0) > 0 &&
            observed > now))
      ) {
        entry.deadlines[kind] = observed
      }
    }
    entry.updatedAt = now
    const due = WINDOWS.filter((kind) => {
      const deadline = entry.deadlines[kind]
      return deadline !== null && deadline <= now && deadline !== entry.attempted[kind]
    })
    if (!due.length) {
      return
    }
    if (codexQuotaAvailability(usage, now) !== 'usable') {
      entry.status = 'deferred'
      return
    }
    if (
      due.every((kind) => (usage[kind]?.usedPercent ?? 0) > 0 && (usage[kind]?.resetsAt ?? 0) > now)
    ) {
      for (const kind of due) {
        entry.attempted[kind] = entry.deadlines[kind]
      }
      entry.status = 'verified'
      return
    }
    if (this.deps.busy(account)) {
      entry.status = 'deferred'
      return
    }
    let submitted = false
    const completed = await this.deps.warm(account, signal, async () => {
      if (!this.current(account, signal) || this.deps.busy(account)) {
        throw new Error('Warmup cancelled')
      }
      for (const kind of due) {
        entry.attempted[kind] = entry.deadlines[kind]
      }
      entry.status = 'attempting'
      await this.deps.save(this.snapshot())
      if (!this.current(account, signal) || this.deps.busy(account)) {
        throw new Error('Warmup cancelled')
      }
      submitted = true
    })
    if (!this.current(account, signal)) {
      return
    }
    entry.status = submitted ? 'unconfirmed' : 'unavailable'
    if (!completed || !submitted) {
      return
    }
    const verified = await this.deps.readUsage(account, signal)
    if (!this.current(account, signal)) {
      return
    }
    if (
      verified?.status === 'ok' &&
      !verified.error &&
      verified.updatedAt >= now &&
      due.every((kind) => {
        const window = verified[kind]
        return window && window.usedPercent > 0 && window.resetsAt !== null && window.resetsAt > now
      })
    ) {
      entry.status = 'verified'
    }
  }
}
