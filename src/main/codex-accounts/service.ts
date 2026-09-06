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
    // Last in the chain so a kill we never issue is never recorded, and a pid
    // Electron owns refuses here into the plain-signal fallback below.
    admitSelfInitiatedTreeKill({
      pid: terminationPid,
      site: 'codex-account-login-teardown',
      scope: 'win-taskkill-tree'
    })
  ) {
    try {
      // Why: child.kill() only reaches the direct child (cmd.exe for npm .cmd
      // shims); taskkill /t also ends codex descendants whose open handles on
      // the managed home make post-login file operations fail with ENOTEMPTY.
      execFileSync('taskkill', ['/pid', String(terminationPid), '/t', '/f'], {
        windowsHide: true,
        timeout: WINDOWS_LOGIN_TREE_KILL_TIMEOUT_MS,
        stdio: 'ignore'
      })
      return
    } catch {
      // Why: taskkill can race an already-exited tree; fall back to the plain
      // signal so the direct child never outlives its deadline.
    }
  }
  child.kill()
}

export class CodexAccountService {
  // Why: serialize the read-modify-write of settings; overlapping calls (e.g. double-click Add) would lose updates.
  private mutationQueue: Promise<unknown> = Promise.resolve()
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
        { windowsHide: true, encoding: 'utf-8', timeout: 5000 }
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

  /**
   * Read-only access for surfaces that report on the runtime home rather than
   * prepare it — notably the config-sync status channel, which must resolve the
   * home the current selection actually mirrors into without creating anything.
   */
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
    return this.serializeMutation(() => this.registration.add(target))
  }

  /**
   * Registers a managed Codex account from an already-authenticated `CODEX_HOME`
   * instead of driving `codex login` here. Lets the `orca account add --agent codex`
   * CLI run the login in the user's own terminal on a headless host and then import
   * the captured `auth.json` into managed storage.
   */
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
    return this.serializeMutation(() => this.registration.reauthenticate(accountId, options))
  }

  async removeAccount(accountId: string): Promise<CodexRateLimitAccountsState> {
    return this.serializeMutation(() => this.selection.remove(accountId))
  }

  async selectAccount(accountId: string | null): Promise<CodexRateLimitAccountsState> {
    return this.serializeMutation(() => this.selection.select(accountId))
  }

  async selectAccountForTarget(
    accountId: string | null,
    target?: CodexAccountSelectionTarget
  ): Promise<CodexRateLimitAccountsState> {
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

  private async runCodexLogin(managedHomePath: string): Promise<void> {
    await runCodexLoginSession(managedHomePath, {
      wslCommand: 'wsl.exe',
      spawn: ({ command, args, env, stdio }) =>
        spawn(command, args, {
          stdio,
          // Why: hide the outer wrapper only. A dedicated login console stays visible.
          windowsHide: true,
          env
        }),
      killProcessTree: killLoginProcessTree
    })
  }
}
