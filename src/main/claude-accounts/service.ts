import type {
  ClaudeAccountSignIn,
  ClaudeRateLimitAccountsState,
  ClaudeSignInRequest
} from '../../shared/managed-account-types'
import { ClaudeAccountRegistration } from './claude-account-registration'
import {
  ClaudeAccountSelection,
  type ClaudeAccountRuntime,
  type ClaudeAccountStore,
  type ClaudeAccountUsage
} from './claude-account-selection'
import { runClaudeCommandProcess } from './claude-command-process'
import { runClaudeLoginSession } from './claude-login-session'
import type { ClaudeRuntimeAuthService } from './runtime-auth-service'
import type { ClaudeAccountSelectionTarget } from './runtime-selection'

export class ClaudeAccountService {
  private mutationQueue: Promise<unknown> = Promise.resolve()
  private cancelPendingClaudeLogin: (() => boolean) | null = null
  private pendingSignInLink: Promise<string | null> | null = null
  private readonly selection: ClaudeAccountSelection
  private readonly registration: ClaudeAccountRegistration

  constructor(
    store: ClaudeAccountStore,
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

  /** A hidden `claude auth login` opens the browser and writes into the new account's folder. */
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

  /** The latest hidden sign-in's link once Claude hands it over; null if it ends without one. */
  waitForSignInLink(): Promise<string | null> {
    return this.pendingSignInLink ?? Promise.resolve(null)
  }

  cancelPendingLogin(): boolean {
    return this.cancelPendingClaudeLogin?.() ?? false
  }

  beginSignIn(request: ClaudeSignInRequest = {}): Promise<ClaudeAccountSignIn> {
    return this.serializeMutation(() => this.registration.begin(request))
  }

  finishSignIn(
    signIn: Omit<ClaudeAccountSignIn, 'configDir'>
  ): Promise<ClaudeRateLimitAccountsState> {
    return this.serializeMutation(() => this.registration.finish(signIn))
  }

  /** Deletes the folder of a sign-in that never became an account; a saved account's is kept. */
  cancelSignIn(signIn: Omit<ClaudeAccountSignIn, 'configDir'>): Promise<void> {
    return this.serializeMutation(() => this.registration.cancel(signIn))
  }

  removeAccount(accountId: string): Promise<ClaudeRateLimitAccountsState> {
    this.supersedePendingLogin()
    return this.serializeMutation(() => this.selection.remove(accountId))
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
    // Why set before queueing: the renderer asks for the link right after starting the sign-in.
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
              }
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

  // Why before the queue, not inside it: the abandoned login owns the queue slot every later
  // account action waits for. Only user-driven actions supersede it.
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
