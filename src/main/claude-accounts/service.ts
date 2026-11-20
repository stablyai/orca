import type {
  ClaudeAccountSignIn,
  ClaudeRateLimitAccountsState,
  ClaudeSignInRequest
} from '../../shared/agent-accounts/managed-account-types'
import { ClaudeAccountRegistration } from './sign-in/claude-account-registration'
import {
  ClaudeAccountSelection,
  type ClaudeAccountRuntime,
  type ClaudeAccountSettings,
  type ClaudeAccountStore,
  type ClaudeAccountUsage
} from './selection/claude-account-selection'
import { runClaudeCommandProcess } from './sign-in/claude-command-process'
import { runClaudeLoginSession } from './sign-in/claude-login-session'
import { runClaudePastedCodeLogin } from './sign-in/claude-pasted-code-login'
import type { HostAccountSignInChannel } from '../../shared/agent-accounts/host-account-sign-in-types'
import type { ClaudeRuntimeAuthService } from './runtime-auth-service'
import type { ClaudeAccountSelectionTarget } from './selection/runtime-selection'
import type { NetworkProxySettings } from '../../shared/network/network-proxy'
import type { ClaudeSelectionOutcome } from './selection/claude-account-selection-sync'

// Sign-in only reads the proxy, so selection and registration never see network fields.
type ClaudeAccountServiceStore = Omit<ClaudeAccountStore, 'getSettings'> & {
  getSettings: () => ClaudeAccountSettings & NetworkProxySettings
}

export class ClaudeAccountService {
  private mutationQueue: Promise<unknown> = Promise.resolve()
  private readonly renameListeners = new Set<() => void>()
  private readonly selectionListeners = new Set<(committed: () => boolean) => void>()
  /** Bumped whenever the saved selection settles: taken effect, or failed and restored. */
  private selectionRevision = 0
  /** A select or remove is running, so the saved selection may not have taken effect yet. */
  private selectionPending = false
  /** A check found the selection pending and stood down; whatever settles it rechecks. */
  private selectionRecheckOwed = false
  /** A failed change could not restore the earlier selection either: no check may act on what is
   *  saved until a later change settles. */
  private selectionRouteUnknown = false
  private cancelPendingClaudeLogin: (() => boolean) | null = null
  private pendingSignInLink: Promise<string | null> | null = null
  private openWslSignInLink: ((signInLink: string) => void) | null = null
  private readonly selection: ClaudeAccountSelection
  private readonly registration: ClaudeAccountRegistration

  constructor(
    private readonly store: ClaudeAccountServiceStore,
    rateLimits: ClaudeAccountUsage,
    private readonly runtimeAuth: ClaudeAccountRuntime &
      Pick<ClaudeRuntimeAuthService, 'getRuntimeConfigDir'>,
    private readonly runLoginCommand = runClaudeCommandProcess
  ) {
    this.selection = new ClaudeAccountSelection(store, rateLimits, runtimeAuth, (outcome) =>
      this.selectionSettled(outcome)
    )
    this.registration = new ClaudeAccountRegistration({
      store,
      rateLimits,
      runtimeAuth,
      selection: this.selection
    })
  }

  private readonly runProxiedLoginCommand: typeof runClaudeCommandProcess = (
    args,
    config,
    timeoutMs,
    options
  ) => {
    const { httpProxyUrl, httpProxyBypassRules } = this.store.getSettings()
    return this.runLoginCommand(args, config, timeoutMs, {
      ...options,
      networkProxySettings: { httpProxyUrl, httpProxyBypassRules }
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

  /** Adds a host account, or re-authenticates `accountId`, through a code pasted on another device. */
  signInWithPastedCode(
    channel: HostAccountSignInChannel,
    accountId?: string
  ): Promise<ClaudeRateLimitAccountsState> {
    this.supersedePendingLogin()
    return this.serializeMutation(() =>
      this.registration.signIn(accountId ? { accountId } : { runtime: 'host' }, (folder) =>
        runClaudePastedCodeLogin(folder, this.runProxiedLoginCommand, channel, (cancel) => {
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
    return this.serializeMutation(() => this.trackSelection(() => this.selection.remove(accountId)))
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
    return this.serializeMutation(() => this.trackSelection(() => this.selection.select(accountId)))
  }

  selectAccountForTarget(
    accountId: string | null,
    target?: ClaudeAccountSelectionTarget
  ): Promise<ClaudeRateLimitAccountsState> {
    this.supersedePendingLogin()
    return this.serializeMutation(() =>
      this.trackSelection(() => this.selection.select(accountId, target))
    )
  }

  /** Called once a select, or a remove of the selected account, reaches new launches, whichever
   *  client made it, and again when a select fails and the earlier selection is restored. The account
   *  may be the same again. `committed` is false while another select or remove runs (whose end then
   *  tells listeners again) and once a later selection takes effect. */
  onSelectionApplied(listener: (committed: () => boolean) => void): () => void {
    this.selectionListeners.add(listener)
    return () => {
      this.selectionListeners.delete(listener)
    }
  }

  private async trackSelection<T>(change: () => Promise<T>): Promise<T> {
    this.selectionPending = true
    try {
      return await change()
    } finally {
      // It failed and the earlier selection was restored: checks run again against it.
      if (this.selectionPending && !this.selectionRouteUnknown) {
        this.selectionSettled('moved')
      }
    }
  }

  /** `moved`: the saved selection changed for new launches (or a failed change restored it). */
  private selectionSettled(outcome: ClaudeSelectionOutcome): void {
    if (outcome === 'unknown') {
      // Stays pending: every check stands down until a later change settles and tells them again.
      this.selectionRouteUnknown = true
      this.selectionRevision += 1
      this.selectionRecheckOwed = true
      return
    }
    this.selectionPending = false
    this.selectionRouteUnknown = false
    if (outcome === 'moved') {
      this.selectionRevision += 1
    } else if (!this.selectionRecheckOwed) {
      // Nothing changed and no check stood down: earlier notifications stay committed.
      return
    }
    this.selectionRecheckOwed = false
    const revision = this.selectionRevision
    const committed = () => {
      if (this.selectionPending) {
        this.selectionRecheckOwed = true
        return false
      }
      return this.selectionRevision === revision
    }
    for (const listener of this.selectionListeners) {
      try {
        listener(committed)
      } catch (error) {
        console.warn('[claude-accounts] A selection listener failed:', error)
      }
    }
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
              runCommand: this.runProxiedLoginCommand,
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
