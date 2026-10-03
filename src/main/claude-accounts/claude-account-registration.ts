import { describeClaudeAccountIdentityRefusal } from '../../shared/claude-account-refusal-copy'
import { findDuplicateClaudeAccount, normalizeClaudeEmail } from './claude-duplicate-account'
import { randomUUID } from 'node:crypto'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { RateLimitService } from '../rate-limits/service'
import type { ClaudeManagedAccount } from '../../shared/managed-account-types'
import type { ClaudeAccountSelection } from './claude-account-selection'
import type { ClaudeRuntimeAuthService } from './runtime-auth-service'
import type { ClaudeAccountSelectionTarget } from './runtime-selection'
import {
  getClaudeSelectionTargetForAccount,
  normalizeClaudeRuntimeSelection
} from './runtime-selection'
import { getClaudeProfileRoutingAuthority } from './claude-profile-routing-authority'
import type { ClaudeLoginIdentity } from './claude-profile-readiness'
import { prepareClaudeProfileLogin, loginToClaudeProfile } from './claude-profile-login'
import { isUnfinishedClaudeSignIn } from '../../shared/claude-unfinished-sign-in'

export class ClaudeAccountRegistration {
  constructor(
    private readonly deps: {
      store: {
        getSettings: () => Pick<
          GlobalSettings,
          | 'claudeManagedAccounts'
          | 'activeClaudeManagedAccountId'
          | 'activeClaudeManagedAccountIdsByRuntime'
          | 'agentStatusHooksEnabled'
          | 'disabledTuiAgents'
        >
        updateSettings: (
          patch: Pick<GlobalSettings, 'claudeManagedAccounts'> &
            Partial<
              Pick<
                GlobalSettings,
                'activeClaudeManagedAccountId' | 'activeClaudeManagedAccountIdsByRuntime'
              >
            >,
          options?: { notifyListeners?: boolean }
        ) => unknown
      }
      rateLimits: Pick<
        RateLimitService,
        'evictInactiveClaudeCache' | 'refreshForClaudeAccountChange'
      >
      runtimeAuth: Pick<ClaudeRuntimeAuthService, 'syncForCurrentSelection'>
      selection: Pick<ClaudeAccountSelection, 'requireAccount' | 'list'>
      setCancel: (cancel: (() => boolean) | null) => void
      prepare?: typeof prepareClaudeProfileLogin
      login?: typeof loginToClaudeProfile
      observeIdentity?: (
        accountId: string,
        target: ClaudeAccountSelectionTarget
      ) => Promise<ClaudeLoginIdentity | null>
    }
  ) {}

  private async createDraft(target: ClaudeAccountSelectionTarget = { runtime: 'host' }) {
    if (target.runtime === 'wsl' && !target.wslDistro) {
      throw new Error('Choose a WSL distro before signing in.')
    }
    const now = Date.now()
    const account: ClaudeManagedAccount = {
      id: randomUUID(),
      email: '',
      managedAuthPath: '',
      managedAuthRuntime: target.runtime ?? 'host',
      wslDistro: target.wslDistro ?? null,
      authMethod: 'unknown',
      createdAt: now,
      updatedAt: now,
      lastAuthenticatedAt: 0
    }
    // A cancelled or interrupted login remains listed so the user can retry or forget it.
    this.save(account)
    await this.publish(target)
    return account.id
  }

  async begin(target: ClaudeAccountSelectionTarget = { runtime: 'host' }, accountId?: string) {
    const id = accountId ?? (await this.createDraft(target))
    const account = this.deps.selection.requireAccount(id)
    let prepared: Awaited<ReturnType<typeof prepareClaudeProfileLogin>>
    try {
      prepared = await (this.deps.prepare ?? prepareClaudeProfileLogin)(
        id,
        getClaudeSelectionTargetForAccount(account),
        this.deps.store.getSettings()
      )
    } catch (error) {
      // Why: no Claude process ran, so a new draft holds nothing to retry; forget only the row.
      if (!accountId) {
        this.forget(id)
        await this.publish(target)
      }
      throw error
    }
    // Why repoint the legacy fields: an older Orca's ownership checks refuse this path, so a
    // downgrade falls back to System Default instead of resuming its legacy token replay.
    this.save({
      ...account,
      managedAuthPath: prepared.config.windowsPath,
      wslLinuxAuthPath: prepared.config.linuxPath
    })
    return { accountId: id, config: prepared.config }
  }

  async add(target?: ClaudeAccountSelectionTarget) {
    const draft = await this.begin(target)
    return this.login(draft.accountId, draft.config)
  }

  async reauthenticate(accountId: string) {
    const draft = await this.begin(undefined, accountId)
    return this.login(accountId, draft.config)
  }

  private async login(accountId: string, config: Parameters<typeof loginToClaudeProfile>[0]) {
    await (this.deps.login ?? loginToClaudeProfile)(config, this.deps.setCancel)
    return this.finish(accountId)
  }

  async finish(accountId: string) {
    const { store, rateLimits, selection } = this.deps
    const account = selection.requireAccount(accountId)
    const target = getClaudeSelectionTargetForAccount(account)
    // Why provision again: setup merges onboarding only into a state file the login just created.
    await (this.deps.prepare ?? prepareClaudeProfileLogin)(accountId, target, store.getSettings())
    // Why the profile, not `claude auth status`: the status command reads this same field, and
    // reading it directly costs no process and cannot be garbled by stderr.
    const identity = await (this.deps.observeIdentity ?? observeClaudeProfileIdentity)(
      accountId,
      target
    )
    if (!identity) {
      throw new Error(
        'Claude sign-in finished, but Orca could not read which account it used. Try signing in again.'
      )
    }
    const takenByAnother = findDuplicateClaudeAccount(
      store.getSettings().claudeManagedAccounts.filter((entry) => entry.id !== accountId),
      {
        email: identity.email,
        organizationUuid: identity.organizationUuid,
        managedAuthRuntime: account.managedAuthRuntime ?? 'host',
        wslDistro: account.wslDistro ?? null
      }
    )
    let createdAt = account.createdAt
    if (isUnfinishedClaudeSignIn(account) && takenByAnother) {
      const existing = selection.list().accounts.find((entry) => entry.id === takenByAnother.id)
      if (existing?.profileReadiness === 'ready' && !existing.profileIdentityIssue) {
        // As before profiles: adding an account that is already signed in adds nothing.
        this.forget(accountId)
        await this.publish(target)
        throw new Error('This Claude account is already added.')
      }
      // Why: a saved account still needing its fresh sign-in is replaced by this profile, which
      // holds that login (settings only). One holding another login stays, flagged, beside it.
      if (existing?.profileReadiness !== 'ready') {
        createdAt = takenByAnother.createdAt
        this.replaceAccount(takenByAnother.id, accountId)
      }
    }
    // Why keep the label: signing an account in to a login another account owns must not take
    // that account's identity; this one then shows what it holds and is flagged instead.
    const keepsLabel =
      !isUnfinishedClaudeSignIn(account) &&
      findDuplicateClaudeAccount(
        store.getSettings().claudeManagedAccounts.filter((entry) => entry.id !== accountId),
        {
          email: identity.email,
          organizationUuid: identity.organizationUuid,
          managedAuthRuntime: account.managedAuthRuntime ?? 'host',
          wslDistro: account.wslDistro ?? null
        }
      ) !== null &&
      normalizeClaudeEmail(account.email) !== normalizeClaudeEmail(identity.email)
    this.save({
      ...account,
      ...(keepsLabel
        ? {}
        : {
            email: identity.email,
            organizationUuid: identity.organizationUuid,
            organizationName: identity.organizationName
          }),
      authMethod: 'subscription-oauth',
      createdAt,
      updatedAt: Date.now(),
      lastAuthenticatedAt: Date.now()
    })
    rateLimits.evictInactiveClaudeCache(accountId)
    await this.publish(target)
    void rateLimits
      .refreshForClaudeAccountChange(undefined, target)
      .catch((error) => console.warn('[claude-profile] Usage unavailable after sign-in:', error))
    const listed = selection.list()
    // Why from list(): the row's flag must be the same derivation every surface shows.
    if (
      listed.accounts.find((entry) => entry.id === accountId)?.profileIdentityIssue === 'duplicate'
    ) {
      throw new Error(
        describeClaudeAccountIdentityRefusal('duplicate', {
          addedAs: keepsLabel ? account.email : identity.email,
          signedInAs: identity.email
        })
      )
    }
    return listed
  }

  private async publish(target: ClaudeAccountSelectionTarget): Promise<void> {
    try {
      await this.deps.runtimeAuth.syncForCurrentSelection(target, 'boot')
    } catch (error) {
      // Publication reports its own UI issue; a stale selection must not block signing in.
      console.warn('[claude-profile] Account selection publication failed:', error)
    }
  }

  private replaceAccount(previousId: string, nextId: string): void {
    const settings = this.deps.store.getSettings()
    const selection = normalizeClaudeRuntimeSelection(settings)
    const swap = (id: string | null) => (id === previousId ? nextId : id)
    this.deps.store.updateSettings(
      {
        claudeManagedAccounts: settings.claudeManagedAccounts.filter(
          (entry) => entry.id !== previousId
        ),
        activeClaudeManagedAccountId: swap(settings.activeClaudeManagedAccountId ?? null),
        activeClaudeManagedAccountIdsByRuntime: {
          host: swap(selection.host),
          wsl: Object.fromEntries(
            Object.entries(selection.wsl).map(([distro, id]) => [distro, swap(id)])
          )
        }
      },
      NOTIFY
    )
  }

  private forget(accountId: string): void {
    this.deps.store.updateSettings(
      {
        claudeManagedAccounts: this.deps.store
          .getSettings()
          .claudeManagedAccounts.filter((entry) => entry.id !== accountId)
      },
      NOTIFY
    )
  }

  private save(account: ClaudeManagedAccount): void {
    const accounts = this.deps.store.getSettings().claudeManagedAccounts
    this.deps.store.updateSettings(
      {
        claudeManagedAccounts: [...accounts.filter((entry) => entry.id !== account.id), account]
      },
      NOTIFY
    )
  }
}

// Why notify: every window's switcher and Settings read the account list from settings.
const NOTIFY = { notifyListeners: true }

/** Re-reads the account's profile; a WSL guest is asked only while it is running. */
async function observeClaudeProfileIdentity(
  accountId: string,
  target: ClaudeAccountSelectionTarget
): Promise<ClaudeLoginIdentity | null> {
  const profiles = getClaudeProfileRoutingAuthority()
  try {
    await profiles?.refreshForRead(target, { managedGuest: true })
  } catch {
    // The account's readiness carries why its profile could not be read.
  }
  return profiles?.observedIdentity(accountId) ?? null
}
