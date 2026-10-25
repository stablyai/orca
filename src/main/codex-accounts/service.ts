import { execFileSync, spawn } from 'node:child_process'
import type { WindowsHostInteractiveLoginSpawn } from '../../shared/windows-interactive-login-spawn'
import type {
  CodexManagedAccount,
  CodexManagedAccountSummary,
  CodexRateLimitAccountsState,
  CodexSystemDefaultIdentity
} from '../../shared/managed-account-types'
import type { CodexRateLimitResetResult } from '../../shared/rate-limit-types'
import type { CodexResetCreditExpectedScope } from '../../shared/codex-reset-credit-scope'
import type { CodexRuntimeHomeService } from './runtime-home-service'
import type { Store } from '../persistence'
import type { RateLimitService } from '../rate-limits/service'
import { buildEncodedWslBashCommand } from '../wsl-bash-command'
import { resolveWslInteropSpawnCwd } from '../wsl-interop-spawn-directory'
import { admitSelfInitiatedTreeKill } from '../own-chromium-tree-kill-guard'
import type { CodexAccountSelectionTarget } from './runtime-selection'
import { CodexAccountIdentity, type ResolvedCodexIdentity } from './codex-account-identity'
import { CodexConfigMirror } from './codex-config-mirror'
import { runCodexLoginSession, type CodexLoginChild } from './codex-login-session'
import { CodexManagedHomePath } from './codex-managed-home-path'
import { CodexManagedHomeLifecycle } from './codex-managed-home-lifecycle'
import { CodexResetCreditCoordinator } from './codex-reset-credit-coordinator'
import { CodexAccountSelection } from './codex-account-selection'
import { CodexAccountRegistration } from './codex-account-registration'
import type {
  CodexAccountAddTarget,
  CodexAccountReauthenticateOptions,
  CodexAccountServiceLifecycle,
  CodexResetCreditConsumeResult
} from './codex-account-service-types'
import { toCodexManagedAccountSummary } from './codex-account-service-types'
import { CODEX_LOGIN_CANCELLED_MESSAGE } from '../../shared/codex-auth-errors'
import type { HostAccountSignInChannel } from '../../shared/host-account-sign-in-types'
export type {
  CodexAccountAddTarget,
  CodexAccountReauthenticateOptions,
  CodexAccountServiceLifecycle,
  CodexResetCreditConsumeResult,
  CodexResetCreditConsumedResult,
  CodexResetCreditRejectedBeforeProviderReason,
  CodexResetCreditRejectedBeforeProviderResult
} from './codex-account-service-types'

const WINDOWS_LOGIN_TREE_KILL_TIMEOUT_MS = 5_000

function killLoginProcessTree(
  child: CodexLoginChild,
  interactiveLogin?: WindowsHostInteractiveLoginSpawn | null
): void {
  const terminationPid = interactiveLogin?.getTerminationPid?.() ?? child.pid
  if (
    process.platform === 'win32' &&
    typeof terminationPid === 'number' &&
    child.exitCode === null &&
    child.signalCode === null &&
    // Record only attempted kills; Electron-owned PIDs fall back to a direct signal.
    admitSelfInitiatedTreeKill({
      pid: terminationPid,
      site: 'codex-account-login-teardown',
      scope: 'win-taskkill-tree'
    })
  ) {
    try {
      // Kill descendants too: their Windows file handles can block post-login home operations.
      execFileSync('taskkill', ['/pid', String(terminationPid), '/t', '/f'], {
        windowsHide: true,
        timeout: WINDOWS_LOGIN_TREE_KILL_TIMEOUT_MS,
        stdio: 'ignore'
      })
      return
    } catch {
      // If the tree already exited, still try signaling the direct child.
    }
  }
  child.kill()
}

export class CodexAccountService {
  // Serialize settings read-modify-write operations to prevent overlapping account changes losing updates.
  private mutationQueue: Promise<unknown> = Promise.resolve()
  private cancelPendingCodexLogin: (() => boolean) | null = null
  private pendingLoginUrl: string | null = null
  private readonly pendingLoginUrlListeners = new Set<(url: string | null) => void>()
  private openWslLoginUrl: ((url: string) => void) | null = null
  private readonly identity: CodexAccountIdentity
  private readonly configMirror: CodexConfigMirror
  private readonly managedHomePaths: CodexManagedHomePath
  private readonly managedHomes: CodexManagedHomeLifecycle
  private readonly resetCredits: CodexResetCreditCoordinator
  private readonly selection: CodexAccountSelection
  private readonly registration: CodexAccountRegistration

  constructor(
    store: Store,
    rateLimits: RateLimitService,
    private readonly runtimeHome: CodexRuntimeHomeService,
    lifecycle: CodexAccountServiceLifecycle = {}
  ) {
    this.managedHomePaths = new CodexManagedHomePath((distro, script) =>
      execFileSync(
        'wsl.exe',
        ['-d', distro, '--exec', 'bash', '-lc', buildEncodedWslBashCommand(script)],
        { windowsHide: true, encoding: 'utf-8', timeout: 5000, cwd: resolveWslInteropSpawnCwd() }
      )
    )
    this.managedHomes = new CodexManagedHomeLifecycle(this.managedHomePaths)
    this.identity = new CodexAccountIdentity((path, accountId) =>
      this.managedHomePaths.assert(path, accountId)
    )
    this.configMirror = new CodexConfigMirror(store, (path, accountId) =>
      this.managedHomePaths.assert(path, accountId)
    )
    this.resetCredits = new CodexResetCreditCoordinator({
      store,
      rateLimits,
      runtimeHome,
      managedHomePaths: this.managedHomePaths,
      serializeMutation: (operation) => this.serializeMutation(operation),
      getSnapshot: () => this.getSnapshot(),
      toSummary: (account) => this.toSummary(account)
    })
    this.selection = new CodexAccountSelection({
      store,
      rateLimits,
      runtimeHome,
      configMirror: this.configMirror,
      lifecycle,
      resolveSystemDefault: () => this.resolveSystemDefaultIdentity(),
      readIdentityFromHome: (path, accountId) => this.readIdentityFromHome(path, accountId),
      removeManagedHome: (path, accountId) => this.safeRemoveManagedHome(path, accountId),
      discardResetAttempts: (accountId) => this.resetCredits.discardForRemovedAccount(accountId)
    })
    this.registration = new CodexAccountRegistration({
      store,
      rateLimits,
      runtimeHome,
      readIdentityFromHome: (path, accountId) => this.readIdentityFromHome(path, accountId),
      selection: this.selection,
      configMirror: this.configMirror,
      managedHomePaths: this.managedHomePaths,
      managedHomes: this.managedHomes,
      login: (managedHomePath) => this.runCodexLogin(managedHomePath)
    })
    this.configMirror.safeSyncToManagedHomes()
  }

  /** Expose runtime-home status without preparing a launch home. */
  get runtimeHomeService(): CodexRuntimeHomeService {
    return this.runtimeHome
  }

  private serializeMutation<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.mutationQueue.then(fn, fn)
    this.mutationQueue = next.catch(() => {})
    return next
  }

  listAccounts(): CodexRateLimitAccountsState {
    return this.selection.list()
  }

  async addAccount(target?: CodexAccountAddTarget): Promise<CodexRateLimitAccountsState> {
    this.supersedePendingLogin()
    return this.serializeMutation(() => this.registration.add(target))
  }

  async addAccountWithDeviceCode(
    channel: HostAccountSignInChannel
  ): Promise<CodexRateLimitAccountsState> {
    this.supersedePendingLogin()
    return this.serializeMutation(() =>
      this.registration.add({ runtime: 'host' }, (managedHomePath) =>
        this.runCodexLogin(managedHomePath, channel)
      )
    )
  }

  cancelPendingLogin(): boolean {
    return this.cancelPendingCodexLogin?.() ?? false
  }

  /** Pending sign-in link for late-joining renderers. */
  getPendingLoginUrl(): string | null {
    return this.pendingLoginUrl
  }

  /** Listeners live for the process lifetime; no teardown is returned. */
  onPendingLoginUrlChanged(listener: (url: string | null) => void): void {
    this.pendingLoginUrlListeners.add(listener)
  }

  /** The desktop supplies a WSL link opener; orcad leaves it unset. */
  setWslLoginUrlOpener(opener: ((url: string) => void) | null): void {
    this.openWslLoginUrl = opener
  }

  private setPendingLoginUrl(url: string | null): void {
    // Suppress duplicate login-link broadcasts to every window.
    if (this.pendingLoginUrl === url) {
      return
    }
    this.pendingLoginUrl = url
    for (const listener of this.pendingLoginUrlListeners) {
      listener(url)
    }
  }

  // Cancel before queueing: abandoned logins hold the slot needed by later user account actions.
  // Background resets share the queue without superseding logins.
  private supersedePendingLogin(): void {
    if (this.cancelPendingLogin()) {
      console.info('[codex-accounts] Cancelled a pending Codex login superseded by a new request.')
    }
  }

  /** Import credentials from a terminal login on a headless host. */
  async addAccountFromHome(
    sourceHome: string,
    target?: CodexAccountAddTarget
  ): Promise<CodexRateLimitAccountsState> {
    return this.serializeMutation(() => this.registration.addFromHome(sourceHome, target))
  }

  async reauthenticateAccount(
    accountId: string,
    options?: CodexAccountReauthenticateOptions
  ): Promise<CodexRateLimitAccountsState> {
    this.supersedePendingLogin()
    return this.serializeMutation(() => this.registration.reauthenticate(accountId, options))
  }

  async removeAccount(accountId: string): Promise<CodexRateLimitAccountsState> {
    this.supersedePendingLogin()
    return this.serializeMutation(() => this.selection.remove(accountId))
  }

  async selectAccount(accountId: string | null): Promise<CodexRateLimitAccountsState> {
    this.supersedePendingLogin()
    return this.serializeMutation(() => this.selection.select(accountId))
  }

  async selectAccountForTarget(
    accountId: string | null,
    target?: CodexAccountSelectionTarget
  ): Promise<CodexRateLimitAccountsState> {
    this.supersedePendingLogin()
    return this.serializeMutation(() => this.selection.select(accountId, target))
  }

  consumeRateLimitResetCredit(
    idempotencyKey: string,
    expectedScope: CodexResetCreditExpectedScope
  ): Promise<CodexResetCreditConsumeResult> {
    return this.resetCredits.consume(idempotencyKey, expectedScope)
  }

  async consumeCurrentRateLimitResetCredit(): Promise<CodexRateLimitResetResult> {
    return this.resetCredits.consumeCurrent()
  }

  private getSnapshot(): CodexRateLimitAccountsState {
    return this.selection.snapshot()
  }

  private resolveSystemDefaultIdentity(): CodexSystemDefaultIdentity {
    return this.identity.resolveSystemDefault()
  }

  private readIdentityFromHome(
    managedHomePath: string,
    expectedAccountId: string
  ): ResolvedCodexIdentity {
    return this.identity.readFromHome(managedHomePath, expectedAccountId)
  }

  private toSummary(account: CodexManagedAccount): CodexManagedAccountSummary {
    return toCodexManagedAccountSummary(account)
  }

  private safeRemoveManagedHome(candidatePath: string, expectedAccountId: string): void {
    this.managedHomes.safeRemove(candidatePath, expectedAccountId)
  }

  private async runCodexLogin(
    managedHomePath: string,
    deviceChannel?: HostAccountSignInChannel
  ): Promise<void> {
    // A device flow cancelled while queued must never spawn a login.
    if (deviceChannel?.signal.aborted) {
      throw new Error(CODEX_LOGIN_CANCELLED_MESSAGE)
    }
    // Capture this login so a late abort cannot cancel a newer flow.
    let cancelThisLogin: (() => boolean) | null = null
    const cancelForChannel = (): void => {
      cancelThisLogin?.()
    }
    deviceChannel?.signal.addEventListener('abort', cancelForChannel, { once: true })
    try {
      await runCodexLoginSession(managedHomePath, {
        wslCommand: 'wsl.exe',
        spawn: ({ command, args, env, stdio }) =>
          spawn(command, args, {
            stdio,
            // Hide the outer wrapper; the dedicated login console remains visible.
            windowsHide: true,
            env
          }),
        killProcessTree: killLoginProcessTree,
        setCancel: (cancel) => {
          this.cancelPendingCodexLogin = cancel
          cancelThisLogin = cancel
        },
        onAuthUrl: (url) => this.setPendingLoginUrl(url),
        openWslAuthUrl: this.openWslLoginUrl,
        ...(deviceChannel
          ? {
              deviceAuth: {
                onPrompt: ({ url, userCode }) =>
                  deviceChannel.onPrompt({ url, userCode, needsCode: false })
              }
            }
          : {})
      })
    } finally {
      deviceChannel?.signal.removeEventListener('abort', cancelForChannel)
      // Clear the link and cancellation handle when their login server ends.
      this.cancelPendingCodexLogin = null
      this.setPendingLoginUrl(null)
    }
  }
}
