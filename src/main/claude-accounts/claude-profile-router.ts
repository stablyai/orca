import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { isAgentStatusHooksEnabledForAgent } from '../../shared/agent-status-hooks-setting'
import {
  CLAUDE_INJECTED_CONFIG_DIR_ENV,
  CLAUDE_PROFILE_POINTER_ENV,
  CLAUDE_PROFILE_SETUP_FAILED_MESSAGE,
  CLAUDE_USER_CONFIG_DIR_ENV
} from '../../shared/claude-profile-routing'
import { claudeProfileMissing, claudeProfileSetupFailed } from './claude-profile-launch-errors'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { probeRecentClaudeCliVersion } from '../claude/claude-hook-event-versions'
import { writeFileAtomically } from '../codex-accounts/fs-utils'
import { resolveClaudeCommand } from '../codex-cli/command'
import {
  claudeProfileMarkerPath,
  describeClaudeProfile,
  type ClaudeProfileDescriptor,
  readUserClaudeConfigDir,
  resolveClaudeDefaultHome
} from './claude-profile-paths'
import type { ClaudeProfileSetupReport } from './claude-profile-setup'
import { runClaudeProfileSetupInWorker } from './claude-profile-setup-worker'
import type { ClaudeEnvPatch } from './environment'
import type { ClaudeRuntimeAuthPreparation } from './runtime-auth/runtime-auth-types'
import {
  findClaudeAccount,
  getSelectedClaudeAccountIdForTarget,
  type ClaudeAccountSelectionTarget
} from './runtime-selection'
import { wslClaudeProfilePointer } from './claude-profile-wsl-paths'
import { isDirectory, listClaudeProfileHomes } from './claude-profile-installed-router'
import {
  claudeStateFile,
  readClaudeFolderLogin,
  removeClaudeAccountFolder,
  isSameClaudeLogin,
  type ClaudeFolderLogin
} from './claude-account-folder'
import { resolveLoginShellEnvironment } from '../startup/login-shell-environment'

const REFRESH_WAIT_MS = 5_000

export type ClaudeProfileRouterSettings = Pick<
  GlobalSettings,
  | 'claudeManagedAccounts'
  | 'activeClaudeManagedAccountId'
  | 'activeClaudeManagedAccountIdsByRuntime'
  | 'agentStatusHooksEnabled'
  | 'disabledTuiAgents'
>

/**
 * Routes this host's Claude launches to the selected account's folder. Settings own the selection;
 * the pointer file mirrors it for `claude` typed in an already-open terminal.
 */
export class ClaudeProfileRouter {
  readonly pointerPath: string
  private readonly setups = new Map<string, Promise<ClaudeProfileSetupReport>>()
  private env: NodeJS.ProcessEnv
  private readonly envReady: Promise<unknown>
  private envResolved: boolean
  constructor(
    private readonly args: {
      getSettings: () => ClaudeProfileRouterSettings
      dataRoot: string
      userHome?: string
      /** Tests replace the login shell's env. */
      env?: NodeJS.ProcessEnv
      /** Tests replace the worker. */
      runSetup?: typeof runClaudeProfileSetupInWorker
      /** Tests shorten how long a launch waits on a refresh. */
      refreshWaitMs?: number
    }
  ) {
    this.pointerPath = join(args.dataRoot, 'claude-profiles', 'selected-host')
    this.env = args.env ?? process.env
    // Why the login shell's: a Dock launch lacks the CLAUDE_CONFIG_DIR an rc exports. Chats share it.
    this.envResolved = Boolean(args.env)
    this.envReady = args.env
      ? Promise.resolve()
      : resolveLoginShellEnvironment().then((env) => {
          this.env = env
          this.envResolved = true
          // Why: a pointer written before then compared against the wrong System default.
          try {
            this.writePointer()
          } catch (error) {
            console.warn('[claude-profile] Could not update the Claude account pointer:', error)
          }
        })
  }

  private get userHome(): string {
    return this.args.userHome ?? homedir()
  }

  private selectedProfile(): ClaudeProfileDescriptor | null {
    const id = getSelectedClaudeAccountIdForTarget(this.args.getSettings(), { runtime: 'host' })
    return id ? this.describe(id) : null
  }

  /** The folder launches run in: the selected account's, unless System default covers it. */
  private routedProfile(): ClaudeProfileDescriptor | null {
    const profile = this.selectedProfile()
    return profile && !this.coveredBySystemDefault(profile.accountId) ? profile : null
  }

  /** The login an account's own folder holds; null until it signs in there. */
  accountLogin(accountId: string): ClaudeFolderLogin | null {
    return readClaudeFolderLogin(claudeStateFile(this.accountHome(accountId), this.userHome))
  }

  /** The login System default holds. */
  systemDefaultLogin(maxAgeMs = 0): ClaudeFolderLogin | null {
    return readClaudeFolderLogin(claudeStateFile(this.userConfigDir(), this.userHome), maxAgeMs)
  }

  /**
   * An account with no login of its own runs on System default while that is signed in to the
   * same email, so an account saved before per-account folders logs nobody out.
   */
  coveredBySystemDefault(accountId: string): boolean {
    if (this.accountLogin(accountId)) {
      return false
    }
    const saved = findClaudeAccount(this.args.getSettings(), accountId)
    const systemDefault = this.systemDefaultLogin()
    return Boolean(saved && systemDefault && isSameClaudeLogin(saved, systemDefault))
  }

  /** The user's System default: their own CLAUDE_CONFIG_DIR, else ~/.claude. */
  systemDefaultHome(): string {
    return resolveClaudeDefaultHome(this.userHome, this.userConfigDir())
  }

  /** Null for System default. Throws for a missing folder: falling back would run the wrong account. */
  routedHome(): string | null {
    const home = this.routedProfile()?.home ?? null
    if (home !== null && !isDirectory(home)) {
      throw claudeProfileMissing()
    }
    return home
  }

  /** Pointer first, then setup in the background, as superset does. No saved accounts means no pointer. */
  publish(): void {
    if (!this.writePointer()) {
      return
    }
    // Why even a missing or covered folder: setup creates it without a login, so a sign-in,
    // or Claude's own first run, signs in there.
    const profile = this.selectedProfile()
    if (profile) {
      this.setUpInBackground(profile)
    }
  }

  /** The routed folder for the `claude` function; false when no account is saved, so no pointer. */
  private writePointer(): boolean {
    if (this.args.getSettings().claudeManagedAccounts.length === 0) {
      rmSync(this.pointerPath, { force: true })
      return false
    }
    const home = this.routedProfile()?.home ?? ''
    // Why compare first: launches re-sync it, and most find it unchanged.
    if (!existsSync(this.pointerPath) || readFileSync(this.pointerPath, 'utf8') !== home) {
      mkdirSync(dirname(this.pointerPath), { recursive: true, mode: 0o700 })
      writeFileAtomically(this.pointerPath, home, { mode: 0o600 })
    }
    return true
  }

  private setUpInBackground(profile: ClaudeProfileDescriptor): void {
    this.setUp(profile).catch((error: unknown) => {
      console.warn('[claude-profile] Account setup failed:', error)
    })
  }

  /** Refreshes the routed folder first; only a first setup that fails stops the launch. */
  async prepareLaunch(): Promise<ClaudeRuntimeAuthPreparation> {
    const selected = this.selectedProfile()
    // Why wait only without the account's own login: System default, and whether it covers the
    // account, depend on the login shell's CLAUDE_CONFIG_DIR; setup awaits it itself.
    if (!selected || !this.accountLogin(selected.accountId)) {
      await this.envReady
    }
    // Why: a sign-in or a System default login change since the last publish moves the route.
    this.writePointer()
    const profile = this.routedProfile()
    if (!profile) {
      return this.preparation()
    }
    // Why the marker: setup writes it last, so a missing folder is set up too.
    if (!existsSync(claudeProfileMarkerPath(profile))) {
      const report = await this.setUp(profile).catch(() => null)
      if (report?.outcome !== 'prepared') {
        throw claudeProfileSetupFailed()
      }
      return this.preparation()
    }
    // Why capped and never thrown: a set-up folder runs on its last refresh rather than not at all.
    const refresh = this.setUp(profile).catch((error: unknown) => {
      console.warn('[claude-profile] Account refresh failed:', error)
    })
    const waitMs = this.args.refreshWaitMs ?? REFRESH_WAIT_MS
    await Promise.race([refresh, new Promise((resolve) => setTimeout(resolve, waitMs).unref())])
    return this.preparation()
  }

  /** An account's folder on this host, whether or not it exists yet. */
  accountHome(accountId: string): string {
    return this.describe(accountId).home
  }

  /** Creates and sets up an account's folder for sign-in; the login itself is Claude's. */
  async prepareAccount(accountId: string): Promise<string> {
    const profile = this.describe(accountId)
    const report = await this.setUp(profile).catch(() => null)
    if (report?.outcome !== 'prepared') {
      throw new Error(CLAUDE_PROFILE_SETUP_FAILED_MESSAGE)
    }
    return profile.home
  }

  /** Deletes an account's folder after any setup running for it, which would otherwise recreate it. */
  async removeAccount(accountId: string): Promise<void> {
    await this.setups.get(accountId)?.catch(() => {})
    await removeClaudeAccountFolder(this.args.dataRoot, accountId)
  }

  /** True once an older Orca copied an account's login into System default: it left this snapshot. */
  copiedLoginIntoSystemDefault(): boolean {
    return existsSync(join(this.args.dataRoot, 'claude-runtime-auth', 'system-default-auth.json'))
  }

  /** The user's own CLAUDE_CONFIG_DIR, which wins over the selection in their terminals. */
  userConfigDir(): string | undefined {
    return readUserClaudeConfigDir(this.env)
  }

  private describe(accountId: string): ClaudeProfileDescriptor {
    return describeClaudeProfile(this.args.dataRoot, accountId, {
      executionHostId: 'local',
      runtime: 'host'
    })
  }

  /** One setup per account at a time; a later request reuses the running one. */
  private setUp(profile: ClaudeProfileDescriptor): Promise<ClaudeProfileSetupReport> {
    const running = this.setups.get(profile.accountId)
    if (running) {
      return running
    }
    const run = this.runSetup(profile).finally(() => this.setups.delete(profile.accountId))
    this.setups.set(profile.accountId, run)
    return run
  }

  private async runSetup(profile: ClaudeProfileDescriptor): Promise<ClaudeProfileSetupReport> {
    await this.envReady
    const hooks = isAgentStatusHooksEnabledForAgent(this.args.getSettings(), 'claude')
    const claudeVersion = hooks ? await probeRecentClaudeCliVersion(resolveClaudeCommand()) : null
    const report = await (this.args.runSetup ?? runClaudeProfileSetupInWorker)({
      dataRoot: this.args.dataRoot,
      profile,
      userHome: this.userHome,
      userConfigDir: this.userConfigDir(),
      hooks,
      claudeVersion: claudeVersion ?? undefined
    })
    if (report.outcome === 'refused' || report.warnings.length > 0) {
      console.warn('[claude-profile] Account setup was incomplete:', report)
    }
    return report
  }

  /** Env for a launch Orca makes itself. Throws like routedHome. */
  launchEnv(): ClaudeEnvPatch {
    const home = this.routedHome()
    return {
      [CLAUDE_PROFILE_POINTER_ENV]: this.pointerPath,
      // Why nothing for System default: the user's inherited CLAUDE_CONFIG_DIR must pass through.
      ...(home ? { CLAUDE_CONFIG_DIR: home, [CLAUDE_INJECTED_CONFIG_DIR_ENV]: home } : {})
    }
  }

  /** A pane's spawn env. Never throws, so a broken selection cannot stop a terminal opening. */
  terminalEnv(target?: ClaudeAccountSelectionTarget): ClaudeEnvPatch {
    // Why only the pointer: the guest's `claude` reads it, so a pane never waits on the guest.
    if (target?.runtime === 'wsl') {
      return { [CLAUDE_PROFILE_POINTER_ENV]: `~/${wslClaudeProfilePointer(this.args.dataRoot)}` }
    }
    // Why only the pointer before the login shell's env: which home runs depends on its
    // CLAUDE_CONFIG_DIR, and the pane's `claude` reads the pointer rewritten once it arrives.
    if (!this.envResolved) {
      return { [CLAUDE_PROFILE_POINTER_ENV]: this.pointerPath }
    }
    try {
      this.writePointer()
      // Why in the background: a pane never waits; its `claude` starts after the refresh, mostly.
      const profile = this.routedProfile()
      if (profile) {
        this.setUpInBackground(profile)
      }
      const env = this.launchEnv()
      const userConfigDir = this.userConfigDir()
      // Why: the injected value replaces the user's own; the claude function restores it on System default.
      return env.CLAUDE_CONFIG_DIR && userConfigDir
        ? { ...env, [CLAUDE_USER_CONFIG_DIR_ENV]: userConfigDir }
        : env
    } catch {
      return { [CLAUDE_PROFILE_POINTER_ENV]: this.pointerPath }
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

  /**
   * Whether `claude` in a terminal opened before routing, which runs System default's login, runs
   * another account than the selected host one. Null with no host account selected.
   */
  systemDefaultRunsAnotherAccount(): boolean | null {
    const profile = this.selectedProfile()
    if (!profile) {
      return null
    }
    const selected =
      this.accountLogin(profile.accountId) ??
      findClaudeAccount(this.args.getSettings(), profile.accountId)
    const systemDefault = this.systemDefaultLogin(5_000)
    return !selected || !systemDefault || !isSameClaudeLogin(selected, systemDefault)
  }

  /** Whether launches run in an account's folder rather than System default's. */
  routesToAccount(): boolean {
    return this.routedProfile() !== null
  }

  /** Where an unselected account's usage is read: where its launches would run once selected. */
  accountUsagePreparation(accountId: string): ClaudeRuntimeAuthPreparation {
    if (this.coveredBySystemDefault(accountId)) {
      // Why no CLAUDE_CONFIG_DIR: naming System default's folder moves Claude to another Keychain item.
      return {
        configDir: this.systemDefaultHome(),
        envPatch: {},
        provenance: 'system'
      }
    }
    const home = this.accountHome(accountId)
    return {
      configDir: home,
      envPatch: { CLAUDE_CONFIG_DIR: home },
      provenance: `profile:${accountId}`
    }
  }

  /** Every account folder on this host, selected or not. */
  accountHomes(): string[] {
    return listClaudeProfileHomes(this.args.dataRoot)
  }
}
