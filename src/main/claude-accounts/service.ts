import type { ClaudeRateLimitAccountsState } from '../../shared/managed-account-types'
import type { Store } from '../persistence'
import type { RateLimitService } from '../rate-limits/service'
import { ClaudeAccountRegistration } from './claude-account-registration'
import { ClaudeAccountSelection } from './claude-account-selection'
import type { ClaudeRuntimeAuthService } from './runtime-auth-service'
import type { ClaudeAccountSelectionTarget } from './runtime-selection'

export type ClaudeAccountAddTarget = {
  runtime?: 'host' | 'wsl'
  wslDistro?: string | null
}

export type ClaudeAccountImportOptions = ClaudeAccountAddTarget & {
  previousLegacyCredentialsSha256?: string | null
}

export class ClaudeAccountService {
  private mutationQueue: Promise<unknown> = Promise.resolve()
  private cancelPendingClaudeLogin: (() => boolean) | null = null
  private readonly selection: ClaudeAccountSelection
  private readonly registration: ClaudeAccountRegistration

  constructor(
    store: Pick<Store, 'getSettings' | 'updateSettings'>,
    rateLimits: Pick<
      RateLimitService,
      'evictInactiveClaudeCache' | 'refreshForClaudeAccountChange'
    >,
    private readonly runtimeAuth: Pick<
      ClaudeRuntimeAuthService,
      | 'syncForCurrentSelection'
      | 'forceMaterializeCurrentSelectionForRollback'
      | 'getRuntimeConfigDir'
    >
  ) {
    this.selection = new ClaudeAccountSelection(store, rateLimits, runtimeAuth)
    this.registration = new ClaudeAccountRegistration({
      store,
      rateLimits,
      runtimeAuth,
      selection: this.selection,
      setCancel: (cancel) => {
        this.cancelPendingClaudeLogin = cancel
      }
    })
  }

  listAccounts(): ClaudeRateLimitAccountsState {
    return this.selection.list()
  }

  async addAccount(target?: ClaudeAccountAddTarget): Promise<ClaudeRateLimitAccountsState> {
    this.supersedePendingLogin()
    return this.serializeMutation(() => this.registration.add(target))
  }

  beginProfileLogin(target?: ClaudeAccountAddTarget) {
    this.supersedePendingLogin()
    return this.serializeMutation(() => this.registration.begin(target))
  }

  finishProfileLogin(accountId: string) {
    return this.serializeMutation(() => this.registration.finish(accountId))
  }

  async addAccountFromConfigDir(
    _configDir: string,
    _options?: ClaudeAccountImportOptions
  ): Promise<ClaudeRateLimitAccountsState> {
    throw new Error(
      'Update the Orca CLI to add accounts. Importing Claude logins is no longer supported.'
    )
  }

  async reauthenticateAccount(accountId: string): Promise<ClaudeRateLimitAccountsState> {
    this.supersedePendingLogin()
    return this.serializeMutation(() => this.registration.reauthenticate(accountId))
  }

  async removeAccount(accountId: string): Promise<ClaudeRateLimitAccountsState> {
    this.supersedePendingLogin()
    return this.serializeMutation(() => this.selection.remove(accountId))
  }

  async selectAccount(accountId: string | null): Promise<ClaudeRateLimitAccountsState> {
    this.supersedePendingLogin()
    return this.serializeMutation(() => this.selection.select(accountId))
  }

  async selectAccountForTarget(
    accountId: string | null,
    target?: ClaudeAccountSelectionTarget
  ): Promise<ClaudeRateLimitAccountsState> {
    this.supersedePendingLogin()
    return this.serializeMutation(() => this.selection.select(accountId, target))
  }

  cancelPendingLogin(): boolean {
    return this.cancelPendingClaudeLogin?.() ?? false
  }

  // Why before the queue, not inside it: the abandoned login owns the queue slot
  // every later account action waits for. Called from the four the user drives,
  // never from serializeMutation, which background work also uses.
  private supersedePendingLogin(): void {
    if (this.cancelPendingLogin()) {
      console.info(
        '[claude-accounts] Cancelled a pending Claude login superseded by a new request.'
      )
    }
  }

  getRuntimeConfigDir(target?: ClaudeAccountSelectionTarget): string {
    return this.runtimeAuth.getRuntimeConfigDir(target)
  }

  private serializeMutation<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.mutationQueue.then(operation, operation)
    this.mutationQueue = next.catch(() => {})
    return next
  }
}
