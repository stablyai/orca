import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  CodexManagedAccount,
  CodexRateLimitAccountsState
} from '../../shared/managed-account-types'
import type { Store } from '../persistence'
import { durableWriteTempPath, writeFileDurable } from '../durable-file-write'
import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'
import { listRecordedCodexPaneAccounts } from '../codex/codex-pane-account-registry'
import { fetchCodexRateLimits } from '../rate-limits/codex-fetcher'
import type { CodexRuntimeHomeService } from './runtime-home-service'
import { CodexResetWarming, codexWarmingStateSchema } from './codex-reset-warming'
import { warmCodexAccount } from './codex-warmup-inference'
import { codexQuotaAvailability } from './codex-automation-policy'
import {
  getCodexSelectionLaneKey,
  getCodexSelectionTargetForAccount,
  getSelectedCodexAccountIdForTarget
} from './runtime-selection'

export class CodexAutomationService {
  private warming: CodexResetWarming | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private unsubscribe: (() => void) | null = null
  private stopped = false
  private failure: string | undefined
  private readonly foregroundHomes = new Map<string, number>()

  constructor(
    private readonly store: Pick<
      Store,
      'getSettings' | 'getProfileStorageDirectory' | 'onSettingsChanged'
    >,
    private readonly homes: Pick<
      CodexRuntimeHomeService,
      'resolveCodexManagedAccountHomeForInactiveFetch'
    >
  ) {}

  async start(): Promise<void> {
    const file = join(this.store.getProfileStorageDirectory(), 'codex-reset-warming.json')
    try {
      let initial = {}
      try {
        initial = codexWarmingStateSchema.parse(JSON.parse(await readFile(file, 'utf8')))
      } catch (error) {
        if (!isDefinitiveAbsence(error)) {
          throw error
        }
      }
      if (this.stopped) {
        return
      }
      this.warming = new CodexResetWarming(initial, {
        accounts: () => this.store.getSettings().codexManagedAccounts,
        enabled: () => this.store.getSettings().codexResetWarming === true,
        busy: (account) => this.isBusy(account),
        readUsage: (account, signal) => this.readUsage(account, signal),
        warm: (account, signal, beforeSubmit) => this.warm(account, signal, beforeSubmit),
        save: (state) => writeFileDurable(durableWriteTempPath(file), file, JSON.stringify(state))
      })
      this.unsubscribe = this.store.onSettingsChanged((updates) => {
        if ('codexResetWarming' in updates || 'codexManagedAccounts' in updates) {
          this.warming?.cancel()
          this.tick()
        }
      })
      this.timer = setInterval(() => this.tick(), 30_000)
      this.timer.unref()
      this.tick()
    } catch {
      this.failure = 'Account automation state could not be loaded. No warmup was sent.'
    }
  }

  stop(): Promise<void> {
    this.stopped = true
    if (this.timer) {
      clearInterval(this.timer)
    }
    this.unsubscribe?.()
    this.warming?.stop()
    return this.warming?.drain() ?? Promise.resolve()
  }

  reportFailure(message: string): void {
    this.failure = message
  }

  async holdForeground(home: string): Promise<() => void> {
    home = normalizeRuntimePathForComparison(home)
    this.foregroundHomes.set(home, (this.foregroundHomes.get(home) ?? 0) + 1)
    this.warming?.cancel()
    await this.warming?.drain().catch(() => {})
    return () => {
      const remaining = (this.foregroundHomes.get(home) ?? 1) - 1
      if (remaining) {
        this.foregroundHomes.set(home, remaining)
      } else {
        this.foregroundHomes.delete(home)
      }
    }
  }

  snapshot(): NonNullable<CodexRateLimitAccountsState['automation']> {
    return {
      warming: Object.fromEntries(
        Object.entries(this.warming?.snapshot() ?? {}).map(([id, entry]) => [
          id,
          {
            status: entry.status === 'attempting' ? 'unconfirmed' : entry.status,
            updatedAt: entry.updatedAt,
            nextResetAt:
              Object.values(entry.deadlines)
                .filter((value): value is number => value !== null)
                .sort((a, b) => a - b)[0] ?? null
          }
        ])
      ),
      ...(this.failure ? { failure: this.failure } : {})
    }
  }

  async findReplacement(
    home: string,
    signal: AbortSignal,
    excludedHomes: readonly string[] = []
  ): Promise<CodexManagedAccount | null> {
    const settings = this.store.getSettings()
    if (!settings.codexAutomaticFailover || this.stopped) {
      return null
    }
    const outgoing = settings.codexManagedAccounts.find(
      (account) => account.managedHomePath === home
    )
    if (!outgoing) {
      return null
    }
    const target = getCodexSelectionTargetForAccount(outgoing)
    if (getSelectedCodexAccountIdForTarget(settings, target) !== outgoing.id) {
      return null
    }
    let nextResetAt: number | null = null
    for (const candidate of settings.codexManagedAccounts) {
      if (
        candidate.id === outgoing.id ||
        excludedHomes.includes(candidate.managedHomePath) ||
        getCodexSelectionLaneKey(getCodexSelectionTargetForAccount(candidate)) !==
          getCodexSelectionLaneKey(target)
      ) {
        continue
      }
      try {
        const usage = await this.readUsage(candidate, signal)
        if (!signal.aborted && codexQuotaAvailability(usage, Date.now()) === 'usable') {
          this.failure = undefined
          return candidate
        }
        const resets = [usage?.session?.resetsAt, usage?.weekly?.resetsAt].filter(
          (value): value is number => value != null && value > Date.now()
        )
        const reset = resets.sort((a, b) => b - a)[0]
        if (reset && (nextResetAt === null || reset < nextResetAt)) {
          nextResetAt = reset
        }
      } catch {
        /* Unverifiable quota is never capacity. */
      }
    }
    this.failure = nextResetAt
      ? `No other Codex account has verified capacity. Next reported reset: ${new Date(nextResetAt).toISOString()}.`
      : 'No other Codex account has verified capacity. Check account usage or sign-in before continuing.'
    return null
  }

  private isBusy(account: CodexManagedAccount): boolean {
    return (
      this.foregroundHomes.has(normalizeRuntimePathForComparison(account.managedHomePath)) ||
      [...listRecordedCodexPaneAccounts().values()].some((pane) => pane.accountId === account.id)
    )
  }

  private async warm(
    account: CodexManagedAccount,
    signal: AbortSignal,
    beforeSubmit: () => Promise<void>
  ): Promise<boolean> {
    const foreground = new AbortController()
    const timer = setInterval(() => {
      try {
        if (this.isBusy(account)) {
          foreground.abort()
        }
      } catch {
        foreground.abort()
      }
    }, 250)
    timer.unref()
    try {
      return await warmCodexAccount({
        home: this.home(account),
        stateDirectory: this.store.getProfileStorageDirectory(),
        signal: AbortSignal.any([signal, foreground.signal]),
        beforeSubmit
      })
    } finally {
      clearInterval(timer)
    }
  }

  private home(account: CodexManagedAccount): string {
    const resolved = this.homes.resolveCodexManagedAccountHomeForInactiveFetch(account)
    if (resolved.kind !== 'ready') {
      throw new Error('Account home is unavailable')
    }
    return resolved.homePath
  }

  private readUsage(account: CodexManagedAccount, signal: AbortSignal) {
    return fetchCodexRateLimits({ codexHomePath: this.home(account), signal })
  }

  private tick(): void {
    if (this.stopped) {
      return
    }
    void this.warming?.tick().catch(() => {
      this.failure = 'Account automation state could not be saved. No new warmup will be retried.'
    })
  }
}
