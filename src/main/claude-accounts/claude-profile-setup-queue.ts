import { getClaudeAgentViewService } from '../claude/agent-view/agent-view-service'
// Runs a host Claude account folder's setup in the worker: one at a time per account, and the
// capped wait a launch puts on it. The router decides which folder; this decides how it is set up.
import { existsSync } from 'node:fs'
import { isAgentStatusHooksEnabledForAgent } from '../../shared/agent-status-hooks-setting'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { probeRecentClaudeCliVersion } from '../claude/claude-hook-event-versions'
import { resolveClaudeCommand } from '../codex-cli/command'
import { claudeProfileSetupFailed } from './claude-profile-launch-errors'
import { claudeProfileMarkerPath, type ClaudeProfileDescriptor } from './claude-profile-paths'
import type { ClaudeProfileSetupReport } from './claude-profile-setup'
import { runClaudeProfileSetupInWorker } from './claude-profile-setup-worker'

const REFRESH_WAIT_MS = 5_000

export class ClaudeProfileSetupQueue {
  private readonly running = new Map<string, Promise<ClaudeProfileSetupReport>>()

  constructor(
    private readonly args: {
      getSettings: () => Pick<GlobalSettings, 'agentStatusHooksEnabled' | 'disabledTuiAgents'>
      dataRoot: string
      userHome: () => string
      userConfigDir: () => string | undefined
      /** Setup reads the login shell's CLAUDE_CONFIG_DIR, so it waits for it. */
      envReady: Promise<unknown>
      runSetup?: typeof runClaudeProfileSetupInWorker
      refreshWaitMs?: number
    }
  ) {}

  /** One setup per account at a time; a later request reuses the running one. */
  run(profile: ClaudeProfileDescriptor): Promise<ClaudeProfileSetupReport> {
    const running = this.running.get(profile.accountId)
    if (running) {
      return running
    }
    const run = this.runOnce(profile).finally(() => this.running.delete(profile.accountId))
    this.running.set(profile.accountId, run)
    return run
  }

  runInBackground(profile: ClaudeProfileDescriptor): void {
    this.run(profile).catch((error: unknown) => {
      console.warn('[claude-profile] Account setup failed:', error)
    })
  }

  /** Resolves once any setup running for the account has finished, however it ended. */
  async settle(accountId: string): Promise<void> {
    await this.running.get(accountId)?.catch(() => {})
  }

  /**
   * The setup a launch waits on. Why the marker: setup writes it last, so a missing folder is set
   * up too, and that first setup must succeed. Why capped and never thrown after that: a set-up
   * folder runs on its last refresh rather than not at all.
   */
  async runForLaunch(profile: ClaudeProfileDescriptor): Promise<void> {
    if (!existsSync(claudeProfileMarkerPath(profile))) {
      const report = await this.run(profile).catch((error: unknown) => {
        console.warn('[claude-profile] Account setup failed:', error)
        return null
      })
      if (report?.outcome !== 'prepared') {
        throw claudeProfileSetupFailed()
      }
      return
    }
    const refresh = this.run(profile).catch((error: unknown) => {
      console.warn('[claude-profile] Account refresh failed:', error)
    })
    const waitMs = this.args.refreshWaitMs ?? REFRESH_WAIT_MS
    await Promise.race([refresh, new Promise((resolve) => setTimeout(resolve, waitMs).unref())])
  }

  private async runOnce(profile: ClaudeProfileDescriptor): Promise<ClaudeProfileSetupReport> {
    await this.args.envReady
    const hooks = isAgentStatusHooksEnabledForAgent(this.args.getSettings(), 'claude')
    const claudeVersion = hooks ? await probeRecentClaudeCliVersion(resolveClaudeCommand()) : null
    const report = await (this.args.runSetup ?? runClaudeProfileSetupInWorker)({
      dataRoot: this.args.dataRoot,
      profile,
      userHome: this.args.userHome(),
      userConfigDir: this.args.userConfigDir(),
      hooks,
      claudeVersion: claudeVersion ?? undefined
    })
    if (report.outcome === 'prepared') {
      await getClaudeAgentViewService(this.args.dataRoot).prepareProfile(profile.home)
    }
    if (report.outcome === 'refused' || report.warnings.length > 0) {
      console.warn('[claude-profile] Account setup was incomplete:', report)
    }
    return report
  }
}
