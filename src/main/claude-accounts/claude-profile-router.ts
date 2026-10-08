import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { isAgentStatusHooksEnabledForAgent } from '../../shared/agent-status-hooks-setting'
import { CLAUDE_PROFILE_POINTER_ENV } from '../../shared/claude-profile-routing'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { probeClaudeCliVersion } from '../claude/claude-hook-event-versions'
import { writeFileAtomically } from '../codex-accounts/fs-utils'
import { resolveClaudeCommand } from '../codex-cli/command'
import {
  CLAUDE_INJECTED_CONFIG_DIR_ENV,
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

export type ClaudeProfileRouterSettings = Pick<
  GlobalSettings,
  | 'claudeManagedAccounts'
  | 'activeClaudeManagedAccountId'
  | 'activeClaudeManagedAccountIdsByRuntime'
  | 'agentStatusHooksEnabled'
  | 'disabledTuiAgents'
>

export const CLAUDE_PROFILE_SETUP_FAILED_MESSAGE =
  'The selected Claude account could not be set up. Try again or choose another account.'

export const CLAUDE_PROFILE_MISSING_MESSAGE =
  "The selected Claude account's folder is missing. Sign in to it again or choose another account."

/**
 * Routes this host's Claude launches to the selected account's folder. Settings own the selection;
 * the pointer file mirrors it for `claude` typed in an already-open terminal.
 */
export class ClaudeProfileRouter {
  readonly pointerPath: string
  private readonly setups = new Map<string, Promise<ClaudeProfileSetupReport>>()
  constructor(
    private readonly args: {
      getSettings: () => ClaudeProfileRouterSettings
      dataRoot: string
      userHome?: string
      env?: NodeJS.ProcessEnv
      /** Tests replace the worker. */
      runSetup?: typeof runClaudeProfileSetupInWorker
    }
  ) {
    this.pointerPath = join(args.dataRoot, 'claude-profiles', 'selected-host')
  }

  private get userHome(): string {
    return this.args.userHome ?? homedir()
  }

  private selectedProfile(): ClaudeProfileDescriptor | null {
    const id = getSelectedClaudeAccountIdForTarget(this.args.getSettings(), { runtime: 'host' })
    return id
      ? describeClaudeProfile(this.args.dataRoot, id, { executionHostId: 'local', runtime: 'host' })
      : null
  }

  /** The user's System default: their own CLAUDE_CONFIG_DIR, else ~/.claude. */
  systemDefaultHome(): string {
    return resolveClaudeDefaultHome(
      this.userHome,
      readUserClaudeConfigDir(this.args.env ?? process.env)
    )
  }

  /** Null for System default. Throws for a missing folder: falling back would run the wrong account. */
  selectedHome(): string | null {
    const home = this.selectedProfile()?.home ?? null
    if (home !== null && !isDirectory(home)) {
      throw new Error(CLAUDE_PROFILE_MISSING_MESSAGE)
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
    // Why the existence check: setup creates the folder, and only sign-in may create an account.
    if (profile && isDirectory(profile.home)) {
      this.setUp(profile).catch((error: unknown) => {
        console.warn('[claude-profile] Account setup failed:', error)
      })
    }
  }

  /** Waits for setup only for a folder that was never set up; otherwise launches at once. */
  async prepareLaunch(): Promise<ClaudeRuntimeAuthPreparation> {
    const profile = this.selectedProfile()
    if (profile && isDirectory(profile.home) && !existsSync(claudeProfileMarkerPath(profile))) {
      const report = await this.setUp(profile).catch(() => null)
      if (report?.outcome !== 'prepared') {
        throw new Error(CLAUDE_PROFILE_SETUP_FAILED_MESSAGE)
      }
    }
    return this.preparation()
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
    const hooks = isAgentStatusHooksEnabledForAgent(this.args.getSettings(), 'claude')
    const claudeVersion = hooks ? await probeClaudeCliVersion(resolveClaudeCommand()) : null
    const report = await (this.args.runSetup ?? runClaudeProfileSetupInWorker)({
      dataRoot: this.args.dataRoot,
      profile,
      userHome: this.userHome,
      userConfigDir: readUserClaudeConfigDir(this.args.env ?? process.env),
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
      return this.launchEnv()
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
