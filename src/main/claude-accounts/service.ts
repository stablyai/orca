import type {
  ClaudeAccountSignIn,
  ClaudeRateLimitAccountsState,
  ClaudeSignInRequest
} from '../../shared/managed-account-types'
import { ClaudeAccountRegistration } from './sign-in/claude-account-registration'
import {
  ClaudeAccountSelection,
  type ClaudeAccountRuntime,
  type ClaudeAccountStore,
  type ClaudeAccountUsage
} from './selection/claude-account-selection'
import { runClaudeCommandProcess } from './sign-in/claude-command-process'
import { runClaudeLoginSession } from './sign-in/claude-login-session'
import { runClaudePastedCodeLogin } from './sign-in/claude-pasted-code-login'
import type { HostAccountSignInChannel } from '../../shared/host-account-sign-in-types'
import type { ClaudeRuntimeAuthService } from './runtime-auth-service'
import type { ClaudeAccountSelectionTarget } from './selection/runtime-selection'

export class ClaudeAccountService {
  private mutationQueue: Promise<unknown> = Promise.resolve()
  private readonly renameListeners = new Set<() => void>()
  private cancelPendingClaudeLogin: (() => boolean) | null = null
  private pendingSignInLink: Promise<string | null> | null = null
  private openWslSignInLink: ((signInLink: string) => void) | null = null
  private readonly selection: ClaudeAccountSelection
  private readonly registration: ClaudeAccountRegistration

  constructor(
    private readonly store: ClaudeAccountStore,
    rateLimits: ClaudeAccountUsage,
    private readonly runtimeAuth: ClaudeAccountRuntime &
      Pick<ClaudeRuntimeAuthService, 'getRuntimeConfigDir'>,
    private readonly runLoginCommand = runClaudeCommandProcess
  ) {
    this.selection = new ClaudeAccountSelection(store, rateLimits, runtimeAuth)
    this.registration = new ClaudeAccountRegistration({
      store,
      rateLimits,
      runtimeAuth,
      selection: this.selection
    })
  }

  listAccounts(): ClaudeRateLimitAccountsState {
    return this.selection.list()
  }

  addAccount(
    target: ClaudeAccountSelectionTarget = {},
    copyLink = false
  ): Promise<ClaudeRateLimitAccountsState> {
    return this.signInHidden({ runtime: target.runtime, wslDistro: target.wslDistro }, copyLink)
  }

  reauthenticateAccount(
    accountId: string,
    copyLink = false
  ): Promise<ClaudeRateLimitAccountsState> {
    return this.signInHidden({ accountId }, copyLink)
  }

  addAccountWithPastedCode(
    channel: HostAccountSignInChannel
  ): Promise<ClaudeRateLimitAccountsState> {
    this.supersedePendingLogin()
    return this.serializeMutation(() =>
      this.registration.signIn({ runtime: 'host' }, (folder) =>
        runClaudePastedCodeLogin(folder, this.runLoginCommand, channel, (cancel) => {
          this.cancelPendingClaudeLogin = cancel
        })
      )
    )
  }

  waitForSignInLink(): Promise<string | null> {
    return this.pendingSignInLink ?? Promise.resolve(null)
  }

  cancelPendingLogin(): boolean {
    return this.cancelPendingClaudeLogin?.() ?? false
  }

  /** The desktop supplies an opener; orcad leaves this unset. */
  setWslSignInLinkOpener(opener: ((signInLink: string) => void) | null): void {
    this.openWslSignInLink = opener
  }

  beginSignIn(request: ClaudeSignInRequest = {}): Promise<ClaudeAccountSignIn> {
    return this.serializeMutation(() => this.registration.begin(request))
  }

  finishSignIn(
    signIn: Omit<ClaudeAccountSignIn, 'configDir'>
  ): Promise<ClaudeRateLimitAccountsState> {
    return this.serializeMutation(() => this.registration.finish(signIn))
  }

  /** Preserve saved accounts when cancelling sign-in. */
  cancelSignIn(signIn: Omit<ClaudeAccountSignIn, 'configDir'>): Promise<void> {
    return this.serializeMutation(() => this.registration.cancel(signIn))
  }

  removeAccount(accountId: string): Promise<ClaudeRateLimitAccountsState> {
    this.supersedePendingLogin()
    return this.serializeMutation(() => this.selection.remove(accountId))
  }

  // Outside the mutation queue: a pending sign-in can hold it for minutes, and this
  // synchronous write touches no state a queued account change reads.
  renameAccount(accountId: string, displayName: string | null): ClaudeRateLimitAccountsState {
    const before = this.store.getSettings().managedAccountDisplayNames
    const state = this.selection.rename(accountId, displayName)
    // Account streams otherwise republish only on usage changes; an unchanged name writes nothing.
    if (this.store.getSettings().managedAccountDisplayNames !== before) {
      for (const listener of this.renameListeners) {
        listener()
      }
    }
    return state
  }

  /** Listeners live as long as their account stream subscription. */
  onAccountRenamed(listener: () => void): () => void {
    this.renameListeners.add(listener)
    return () => {
      this.renameListeners.delete(listener)
    }
  }

  selectAccount(accountId: string | null): Promise<ClaudeRateLimitAccountsState> {
    this.supersedePendingLogin()
    return this.serializeMutation(() => this.selection.select(accountId))
  }

  selectAccountForTarget(
    accountId: string | null,
    target?: ClaudeAccountSelectionTarget
  ): Promise<ClaudeRateLimitAccountsState> {
    this.supersedePendingLogin()
    return this.serializeMutation(() => this.selection.select(accountId, target))
  }

  getRuntimeConfigDir(target?: ClaudeAccountSelectionTarget): string {
    return this.runtimeAuth.getRuntimeConfigDir(target)
  }

  private signInHidden(
    request: ClaudeSignInRequest,
    copyLink: boolean
  ): Promise<ClaudeRateLimitAccountsState> {
    this.supersedePendingLogin()
    // Expose the link promise before queueing so the renderer can request it immediately.
    const signInLink = copyLink ? Promise.withResolvers<string | null>() : null
    this.pendingSignInLink = signInLink?.promise ?? null
    return this.serializeMutation(async () => {
      try {
        return await this.registration.signIn(request, (folder) =>
          runClaudeLoginSession(
            folder,
            {
              runCommand: this.runLoginCommand,
              setCancel: (cancel) => {
                this.cancelPendingClaudeLogin = cancel
              },
              openWslSignInLink: this.openWslSignInLink
            },
            signInLink?.resolve
          )
        )
      } finally {
        signInLink?.resolve(null)
        if (signInLink && this.pendingSignInLink === signInLink.promise) {
          this.pendingSignInLink = null
        }
      }
    })
  }

  // User actions cancel before queueing because the pending login holds the queue slot.
  private supersedePendingLogin(): void {
    if (this.cancelPendingLogin()) {
      console.info(
        '[claude-accounts] Cancelled a pending Claude login superseded by a new request.'
      )
    }
  }

  private serializeMutation<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.mutationQueue.then(operation, operation)
    this.mutationQueue = next.catch(() => {})
    return next
  }
}
