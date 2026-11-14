import { normalizeRuntimePathForComparison } from '../../../shared/cross-platform-path'
import { DynamicAccountLaunchPick } from '../../providers/accounts/dynamic-account-launch-pick'
import type { RateLimitService } from '../../rate-limits/service/rate-limit-service'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { ClaudeProfileRouter } from '../profiles/routing/claude-profile-router'
import { isHostManagedClaudeAccount } from '../runtime-auth/environment'
import { claudeProvenanceAccountId } from '../runtime-auth/runtime-auth-types'

export type ClaudeDynamicLaunchReadings = Pick<
  RateLimitService,
  | 'fetchInactiveClaudeAccountsOnOpen'
  | 'getState'
  | 'requestUsageReading'
  | 'usageReading'
  | 'usageReadingAccount'
>

/** Host account routing while dynamic launch is on; a null account is System default. */
export class ClaudeDynamicLaunch {
  private readonly launches = new DynamicAccountLaunchPick()

  constructor(
    private readonly router: ClaudeProfileRouter,
    private readonly getSettings: () => Pick<
      GlobalSettings,
      'claudeManagedAccounts' | 'claudeDynamicAccountLaunch' | 'dynamicAccountMarginPercent'
    >,
    private readonly readings: ClaudeDynamicLaunchReadings
  ) {}

  /** The signed-in account a new launch takes instead of the selected route; null keeps it. */
  async newLaunchAccount(): Promise<string | null> {
    const settings = this.getSettings()
    if (settings.claudeDynamicAccountLaunch !== true) {
      return null
    }
    await this.launches.refresh(this.readings, 'claude', () =>
      this.readings.fetchInactiveClaudeAccountsOnOpen()
    )
    return this.launches.pick(settings, () => {
      const routed = this.routedAccountId()
      const source = this.readings.usageReadingAccount('claude')?.provenance ?? ''
      const sourceId = source === 'system' ? null : claudeProvenanceAccountId(source)
      return [
        {
          accountId: routed,
          rateLimits: sourceId === routed ? this.readings.usageReading('claude') : null
        },
        ...this.readings
          .getState()
          .inactiveClaudeAccounts.filter(
            ({ accountId }) =>
              accountId !== routed &&
              isHostManagedClaudeAccount(settings.claudeManagedAccounts, accountId) &&
              this.router.accountLogin(accountId)
          )
      ]
    })
  }

  /** The folder a new chat pins, so its later launches keep that account; null keeps the selection. */
  async newChatHome(): Promise<string | null> {
    const accountId = await this.newLaunchAccount()
    return accountId ? this.router.accountHome(accountId) : null
  }

  /** The account a chat pinned to `home` keeps; undefined follows the selection. */
  pinnedAccount(home: string | null): string | null | undefined {
    const settings = this.getSettings()
    if (settings.claudeDynamicAccountLaunch !== true || home === null) {
      return undefined
    }
    const pinned = normalizeRuntimePathForComparison(home)
    if (pinned === normalizeRuntimePathForComparison(this.router.systemDefaultHome())) {
      return null
    }
    // A removed account's chat finds no owner here and follows the selection again.
    const account = settings.claudeManagedAccounts.find(
      (candidate) =>
        candidate.managedAuthRuntime !== 'wsl' &&
        normalizeRuntimePathForComparison(this.router.accountHome(candidate.id)) === pinned
    )
    // A covered account launches through System default, as the selection would route it.
    return account && this.router.coveredBySystemDefault(account.id) ? null : account?.id
  }

  private routedAccountId(): string | null {
    return this.router.routesToAccount() ? (this.router.selectedProfile()?.accountId ?? null) : null
  }
}
