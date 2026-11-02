import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  CLAUDE_INJECTED_CONFIG_DIR_ENV,
  CLAUDE_PROFILE_POINTER_ENV,
  CLAUDE_PROFILE_SETUP_FAILED_MESSAGE,
  CLAUDE_USER_CONFIG_DIR_ENV
} from '../../shared/claude-profile-routing'
import { claudeProfileMissing } from './claude-profile-launch-errors'
import { ClaudeProfileSetupQueue } from './claude-profile-setup-queue'
import {
  chosenAccountLaunchEnv,
  chosenAccountPreparation,
  prepareChosenAccountLaunch,
  type ChosenAccountRouting
} from './claude-profile-chosen-account'
import { systemDefaultRunsAnotherAccount } from './claude-profile-system-default-comparison'
import { claudeAccountUsagePreparation } from './claude-account-usage-preparation'
import { claudeProfileSelectionHomes } from './claude-profile-selection-homes'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { ClaudeManagedAccount } from '../../shared/managed-account-types'
import { writeFileAtomically } from '../codex-accounts/fs-utils'
import {
  describeClaudeProfile,
  type ClaudeProfileDescriptor,
  readUserClaudeConfigDir,
  readUserClaudeConfigDirAsSet,
  resolveClaudeDefaultHome
} from './claude-profile-paths'
import type { runClaudeProfileSetupInWorker } from './claude-profile-setup-worker'
import type { ClaudeEnvPatch } from './environment'
import type { ClaudeRuntimeAuthPreparation } from './runtime-auth/runtime-auth-types'
import {
  findClaudeAccount,
  getSelectedClaudeAccountIdForTarget,
  type ClaudeAccountSelectionTarget
} from './runtime-selection'
import { wslClaudeProfilePointer } from './claude-profile-wsl-paths'
import { isDirectory, listClaudeProfileHomes } from './claude-profile-homes'
import {
  claudeStateFile,
  readClaudeFolderLogin,
  removeClaudeAccountFolder,
  isSameClaudeLogin,
  type ClaudeFolderLogin
} from './claude-account-folder'
import { resolveLoginShellEnvironment } from '../startup/login-shell-environment'
import { claudeAssignedAccountForProviderSession } from './claude-pane-account-registry'

export type ClaudeProfileRouterSettings = Pick<
  GlobalSettings,
  | 'claudeManagedAccounts'
  | 'activeClaudeManagedAccountId'
  | 'activeClaudeManagedAccountIdsByRuntime'
  | 'agentStatusHooksEnabled'
  | 'disabledTuiAgents'
>

/** Mirror the settings selection to a pointer file for Claude in existing terminals. */
export class ClaudeProfileRouter {
  readonly pointerPath: string
  private readonly setups: ClaudeProfileSetupQueue
  private env: NodeJS.ProcessEnv
  private readonly envReady: Promise<unknown>
  private envResolved: boolean
  constructor(
    private readonly args: {
      getSettings: () => ClaudeProfileRouterSettings
      dataRoot: string
      userHome?: string
      env?: NodeJS.ProcessEnv
      runSetup?: typeof runClaudeProfileSetupInWorker
      refreshWaitMs?: number
    }
  ) {
    this.pointerPath = join(args.dataRoot, 'claude-profiles', 'selected-host')
    this.env = args.env ?? process.env
    // Dock launches lack CLAUDE_CONFIG_DIR exported by shell startup files.
    this.envResolved = Boolean(args.env)
    this.envReady = args.env
      ? Promise.resolve()
      : resolveLoginShellEnvironment().then((env) => {
          this.env = env
          this.envResolved = true
          // Recompute routing using the resolved System default.
          try {
            this.writePointer()
          } catch (error) {
            console.warn('[claude-profile] Could not update the Claude account pointer:', error)
          }
        })
    this.setups = new ClaudeProfileSetupQueue({
      getSettings: args.getSettings,
      dataRoot: args.dataRoot,
      runSetup: args.runSetup,
      refreshWaitMs: args.refreshWaitMs,
      userHome: () => this.userHome,
      userConfigDir: () => this.userConfigDir(),
      envReady: this.envReady
    })
  }

  get userHome(): string {
    return this.args.userHome ?? homedir()
  }

  selectedProfile(): ClaudeProfileDescriptor | null {
    const id = getSelectedClaudeAccountIdForTarget(this.args.getSettings(), { runtime: 'host' })
    return id ? this.describe(id) : null
  }

  private routedProfile(): ClaudeProfileDescriptor | null {
    const profile = this.selectedProfile()
    return profile && !this.coveredBySystemDefault(profile.accountId) ? profile : null
  }

  accountLogin(accountId: string): ClaudeFolderLogin | null {
    return readClaudeFolderLogin(claudeStateFile(this.accountHome(accountId), this.userHome))
  }

  systemDefaultLogin(maxAgeMs = 0): ClaudeFolderLogin | null {
    return readClaudeFolderLogin(claudeStateFile(this.userConfigDir(), this.userHome), maxAgeMs)
  }

  /** Reuse a matching System default login until a legacy account signs in separately. */
  coveredBySystemDefault(accountId: string): boolean {
    if (this.accountLogin(accountId)) {
      return false
    }
    const saved = this.savedAccount(accountId)
    const systemDefault = this.systemDefaultLogin()
    return Boolean(saved && systemDefault && isSameClaudeLogin(saved, systemDefault))
  }

  savedAccount(accountId: string): ClaudeManagedAccount | undefined {
    return findClaudeAccount(this.args.getSettings(), accountId)
  }

  systemDefaultHome(): string {
    return resolveClaudeDefaultHome(this.userHome, this.userConfigDir())
  }

  /** Never fall back from a missing folder: that would run the wrong account. */
  /** Never fall back from a missing folder: that would run the wrong account. `identity` names
   *  the selected route before its folder exists; launches and reads still check availability. */
  routedHome(availability: 'checked' | 'identity' = 'checked'): string | null {
    const home = this.routedProfile()?.home ?? null
    if (availability === 'checked' && home !== null && !isDirectory(home)) {
      throw claudeProfileMissing()
    }
    return home
  }

  /** Publish the pointer before starting background setup. */
  publish(): void {
    if (!this.writePointer()) {
      return
    }
    // Create missing or covered folders without a login so they can sign in separately.
    const profile = this.selectedProfile()
    if (profile) {
      this.setups.runInBackground(profile)
    }
  }

  private writePointer(): boolean {
    if (this.args.getSettings().claudeManagedAccounts.length === 0) {
      rmSync(this.pointerPath, { force: true })
      return false
    }
    const home = this.routedProfile()?.home ?? ''
    // Avoid rewriting the pointer on every launch.
    if (!existsSync(this.pointerPath) || readFileSync(this.pointerPath, 'utf8') !== home) {
      mkdirSync(dirname(this.pointerPath), { recursive: true, mode: 0o700 })
      writeFileAtomically(this.pointerPath, home, { mode: 0o600 })
    }
    return true
  }

  /** Refreshes the routed folder first; only a first setup that fails stops the launch. */
  async prepareLaunch(): Promise<ClaudeRuntimeAuthPreparation> {
    const selected = this.selectedProfile()
    // Only fallback routing needs the shell env; account setup waits for it separately.
    if (!selected || !this.accountLogin(selected.accountId)) {
      await this.envReady
    }
    // Login changes since publication can change the route.
    this.writePointer()
    const profile = this.routedProfile()
    if (profile) {
      await this.setups.runForLaunch(profile)
    }
    return this.preparation()
  }

  accountHome(accountId: string): string {
    return this.describe(accountId).home
  }

  async prepareAccount(accountId: string): Promise<string> {
    const profile = this.describe(accountId)
    const report = await this.setups.run(profile).catch(() => null)
    if (report?.outcome !== 'prepared') {
      throw new Error(CLAUDE_PROFILE_SETUP_FAILED_MESSAGE)
    }
    return profile.home
  }

  /** Wait for setup before deleting so it cannot recreate the folder. */
  async removeAccount(accountId: string): Promise<void> {
    await this.setups.settle(accountId)
    await removeClaudeAccountFolder(this.args.dataRoot, accountId)
  }

  /** A legacy snapshot records copy-based account switching. */
  copiedLoginIntoSystemDefault(): boolean {
    return existsSync(join(this.args.dataRoot, 'claude-runtime-auth', 'system-default-auth.json'))
  }

  userConfigDir(): string | undefined {
    return readUserClaudeConfigDir(this.env)
  }

  private describe(accountId: string): ClaudeProfileDescriptor {
    return describeClaudeProfile(this.args.dataRoot, accountId, {
      executionHostId: 'local',
      runtime: 'host'
    })
  }

  /** Account recorded for this provider session, so a later resume can stay on it. */
  assignedAccountForResume(sessionId: string): string | null {
    return claudeAssignedAccountForProviderSession(sessionId)
  }

  /** Env for a launch Orca makes itself. Throws like routedHome. */
  launchEnv(): ClaudeEnvPatch {
    const home = this.routedHome()
    return {
      [CLAUDE_PROFILE_POINTER_ENV]: this.pointerPath,
      // Preserve the user's inherited CLAUDE_CONFIG_DIR for System default.
      ...(home ? { CLAUDE_CONFIG_DIR: home, [CLAUDE_INJECTED_CONFIG_DIR_ENV]: home } : {})
    }
  }

  /** What chosen-account launches borrow from this router. */
  private readonly chosen: ChosenAccountRouting = {
    getSettings: () => this.args.getSettings(),
    coveredBySystemDefault: (id) => this.coveredBySystemDefault(id),
    hasOwnLogin: (id) => Boolean(this.accountLogin(id)),
    accountHome: (id) => this.accountHome(id),
    systemDefaultHome: () => this.systemDefaultHome(),
    env: () => this.env,
    envReady: () => this.envReady,
    setUpForLaunch: (id) => this.setups.runForLaunch(this.describe(id))
  }

  /**
   * Env for a launch on a chosen host account. Throws for an unknown or WSL account and a missing folder.
   * Apply it to a base env free of Orca's routing keys (see chosenAccountLaunchEnv), or a covered
   * account can run on the selected one. Before the login shell resolves (a Dock launch) coverage is
   * judged against process.env and can misclassify; real launches use prepareLaunchFor.
   */
  launchEnvFor(accountId: string): ClaudeEnvPatch {
    return chosenAccountLaunchEnv(this.chosen, accountId)
  }

  /**
   * Like preparation(), for a chosen host account. Before the login shell resolves (a Dock launch)
   * coverage is judged against process.env and can misclassify; real launches use prepareLaunchFor.
   */
  preparationFor(accountId: string): ClaudeRuntimeAuthPreparation {
    return chosenAccountPreparation(this.chosen, accountId)
  }

  /** Like prepareLaunch(), for a chosen host account. */
  prepareLaunchFor(accountId: string): Promise<ClaudeRuntimeAuthPreparation> {
    return prepareChosenAccountLaunch(this.chosen, accountId)
  }

  /** A pane's spawn env. Never throws, so a broken selection cannot stop a terminal opening. */
  terminalEnv(target?: ClaudeAccountSelectionTarget): ClaudeEnvPatch {
    // Pass the pointer without waiting on the guest.
    if (target?.runtime === 'wsl') {
      return { [CLAUDE_PROFILE_POINTER_ENV]: `~/${wslClaudeProfilePointer(this.args.dataRoot)}` }
    }
    // Save the user's value so the shell function can restore it on System default.
    const userConfigDir = readUserClaudeConfigDirAsSet(this.env)
    const base: ClaudeEnvPatch = {
      [CLAUDE_PROFILE_POINTER_ENV]: this.pointerPath,
      ...(userConfigDir ? { [CLAUDE_USER_CONFIG_DIR_ENV]: userConfigDir } : {})
    }
    // Defer routing until the shell env resolves; the shell function will read the updated pointer.
    if (!this.envResolved) {
      return base
    }
    try {
      this.writePointer()
      // Refresh without delaying terminal creation.
      const profile = this.routedProfile()
      if (profile) {
        this.setups.runInBackground(profile)
      }
      return { ...base, ...this.launchEnv() }
    } catch {
      return base
    }
  }

  preparation(): ClaudeRuntimeAuthPreparation {
    const profile = this.routedProfile()
    const home = this.routedHome()
    return {
      configDir: home ?? this.systemDefaultHome(),
      runtime: 'host',
      wslDistro: null,
      wslLinuxConfigDir: null,
      envPatch: this.launchEnv(),
      provenance: home ? `profile:${profile?.accountId}` : 'system'
    }
  }

  /** Compare pre-routing terminals against the selection; null means no account is selected. */
  systemDefaultRunsAnotherAccount(): boolean | null {
    const id = this.selectedProfile()?.accountId
    return id
      ? systemDefaultRunsAnotherAccount(this, id, findClaudeAccount(this.args.getSettings(), id))
      : null
  }

  routesToAccount(): boolean {
    return this.routedProfile() !== null
  }

  /** Read usage from the same login the account would launch with. */
  accountUsagePreparation(accountId: string): ClaudeRuntimeAuthPreparation {
    return claudeAccountUsagePreparation(this, accountId)
  }

  async accountSelectionHomes(launchEnv: NodeJS.ProcessEnv = process.env): Promise<string[]> {
    return claudeProfileSelectionHomes(this, this.args.getSettings(), this.envReady, launchEnv)
  }

  accountHomes(): string[] {
    return listClaudeProfileHomes(this.args.dataRoot)
  }
}
