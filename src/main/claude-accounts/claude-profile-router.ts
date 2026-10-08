import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { isAgentStatusHooksEnabledForAgent } from '../../shared/agent-status-hooks-setting'
import {
  CLAUDE_INJECTED_CONFIG_DIR_ENV,
  CLAUDE_PROFILE_MISSING_MESSAGE,
  CLAUDE_PROFILE_POINTER_ENV,
  CLAUDE_PROFILE_SETUP_FAILED_MESSAGE,
  CLAUDE_USER_CONFIG_DIR_ENV
} from '../../shared/claude-profile-routing'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { probeClaudeCliVersion } from '../claude/claude-hook-event-versions'
import { writeFileAtomically } from '../codex-accounts/fs-utils'
import { resolveClaudeCommand } from '../codex-cli/command'
import { AgentSessionPreSpawnError } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
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
  getSelectedClaudeAccountIdForTarget,
  type ClaudeAccountSelectionTarget
} from './runtime-selection'
import { wslClaudeProfilePointer } from './claude-profile-wsl-paths'
import { isDirectory, listClaudeProfileHomes } from './claude-profile-installed-router'
import { removeClaudeAccountFolder } from './claude-account-folder'
import { resolveLoginShellEnvironment } from '../startup/login-shell-environment'

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
  constructor(
    private readonly args: {
      getSettings: () => ClaudeProfileRouterSettings
      dataRoot: string
      userHome?: string
      /** Tests replace the login shell's env. */
      env?: NodeJS.ProcessEnv
      /** Tests replace the worker. */
      runSetup?: typeof runClaudeProfileSetupInWorker
    }
  ) {
    this.pointerPath = join(args.dataRoot, 'claude-profiles', 'selected-host')
    this.env = args.env ?? process.env
    // Why the login shell's: a Dock launch lacks the CLAUDE_CONFIG_DIR an rc exports. Chats share it.
    this.envReady = args.env
      ? Promise.resolve()
      : resolveLoginShellEnvironment().then((env) => (this.env = env))
  }

  private get userHome(): string {
    return this.args.userHome ?? homedir()
  }

  private selectedProfile(): ClaudeProfileDescriptor | null {
    const id = getSelectedClaudeAccountIdForTarget(this.args.getSettings(), { runtime: 'host' })
    return id ? this.describe(id) : null
  }

  /** The user's System default: their own CLAUDE_CONFIG_DIR, else ~/.claude. */
  systemDefaultHome(): string {
    return resolveClaudeDefaultHome(this.userHome, this.userConfigDir())
  }

  /** Null for System default. Throws for a missing folder: falling back would run the wrong account. */
  selectedHome(): string | null {
    const home = this.selectedProfile()?.home ?? null
    if (home !== null && !isDirectory(home)) {
      throw claudeProfileMissing()
    }
    return home
  }

  /** Pointer first, then setup in the background, as superset does. No saved accounts means no pointer. */
  publish(): void {
    if (this.args.getSettings().claudeManagedAccounts.length === 0) {
      rmSync(this.pointerPath, { force: true })
      return
    }
    const profile = this.selectedProfile()
    mkdirSync(dirname(this.pointerPath), { recursive: true, mode: 0o700 })
    writeFileAtomically(this.pointerPath, profile?.home ?? '', { mode: 0o600 })
    // Why even a missing folder: setup creates it without a login, so Claude's own first run
    // signs in there (an account saved before per-account folders has none yet).
    if (profile) {
      this.setUp(profile).catch((error: unknown) => {
        console.warn('[claude-profile] Account setup failed:', error)
      })
    }
  }

  /** Waits for a first setup that never finished, running or not; otherwise launches at once. */
  async prepareLaunch(): Promise<ClaudeRuntimeAuthPreparation> {
    const profile = this.selectedProfile()
    if (!profile) {
      // Only System default reads the login shell's env here; setup awaits it itself.
      await this.envReady
      return this.preparation()
    }
    // Why the marker: setup writes it last, so a missing folder is set up too. A re-run of a
    // set-up folder never blocks.
    if (!existsSync(claudeProfileMarkerPath(profile))) {
      const report = await this.setUp(profile).catch(() => null)
      if (report?.outcome !== 'prepared') {
        throw claudeProfileSetupFailed()
      }
    }
    return this.preparation()
  }

  /** An account's folder on this host, whether or not it exists yet. */
  accountHome(accountId: string): string {
    return this.describe(accountId).home
  }

  /** prepareLaunch for a named account, which a `--account` launch runs on instead of the selection. */
  async prepareAccountLaunch(accountId: string): Promise<string> {
    const profile = this.describe(accountId)
    if (!existsSync(claudeProfileMarkerPath(profile))) {
      const report = await this.setUp(profile).catch(() => null)
      if (report?.outcome !== 'prepared') {
        throw claudeProfileSetupFailed()
      }
    }
    return profile.home
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
    const claudeVersion = hooks ? await probeClaudeCliVersion(resolveClaudeCommand()) : null
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

  /** Env for a launch Orca makes itself. Throws like selectedHome. */
  launchEnv(): ClaudeEnvPatch {
    const home = this.selectedHome()
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
    try {
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
    const home = this.selectedHome()
    return {
      configDir: home ?? this.systemDefaultHome(),
      runtime: 'host',
      wslDistro: null,
      wslLinuxConfigDir: null,
      envPatch: this.launchEnv(),
      stripAuthEnv: home !== null,
      provenance: home ? `profile:${this.selectedProfile()?.accountId}` : 'system'
    }
  }

  /** Every account folder on this host, selected or not. */
  accountHomes(): string[] {
    return listClaudeProfileHomes(this.args.dataRoot)
  }
}

// Typed so a chat names the situation; a terminal reads the same message.
export function claudeProfileMissing(): AgentSessionPreSpawnError {
  return new AgentSessionPreSpawnError(new Error(CLAUDE_PROFILE_MISSING_MESSAGE), {
    reason: 'claudeAccountFolderMissing'
  })
}

export function claudeProfileSetupFailed(): AgentSessionPreSpawnError {
  return new AgentSessionPreSpawnError(new Error(CLAUDE_PROFILE_SETUP_FAILED_MESSAGE), {
    reason: 'claudeAccountSetupFailed'
  })
}
