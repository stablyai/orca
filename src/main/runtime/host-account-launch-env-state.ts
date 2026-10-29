import { retireAtRestCommandContext } from '../native-chat/agent-session-wire/at-rest-command-context'
import { agentModelCatalogStore } from '../native-chat/agent-model-catalog/agent-model-catalog-store'
import type { CommitMessageAgentEnvironmentResolvers } from '../text-generation/commit-message-agent-environment'
import {
  hostAccountLaunchEnvFor,
  type HostAccountLaunchEnv
} from '../../shared/host-account-launch-env'
import {
  refreshSelectedClaudeProfile,
  type HostClaudeProfileRefresh
} from './host-claude-profile-refresh'
import { FirstHostLaunchEnvGate } from './first-host-launch-env-gate'

/** The account env a desktop pushes to a host without account services of its own (a WSL host). */
export class HostAccountLaunchEnvState {
  /** Pushed by the desktop that owns this host's accounts; held in memory, re-pushed on connect. */
  private hostLaunchEnv: HostAccountLaunchEnv | null = null
  private persistHostLaunchEnv: ((launchEnv: HostAccountLaunchEnv) => void) | null = null
  private readonly firstHostLaunchEnv = new FirstHostLaunchEnvGate()
  private refreshClaudeProfile: HostClaudeProfileRefresh | null = null

  constructor(private readonly hasOwnAccountServices: () => boolean) {}

  get current(): HostAccountLaunchEnv | null {
    return this.hostLaunchEnv
  }

  /** Commit-message launches on a host the desktop manages; undefined before any env or wait. */
  commitMessageAgentEnvironment(): CommitMessageAgentEnvironmentResolvers | undefined {
    if (!this.hostLaunchEnv && !this.firstHostLaunchEnv.armed) {
      return undefined
    }
    const currentHostLaunchEnv = async (agent: string): Promise<HostAccountLaunchEnv | null> => {
      await this.prepareHostAgentLaunch(agent)
      return this.hostLaunchEnv
    }
    return {
      prepareForCodexLaunch: async () =>
        (await currentHostLaunchEnv('codex'))?.terminal.CODEX_HOME ?? null,
      prepareForClaudeLaunch: async () => {
        const claude = (await currentHostLaunchEnv('claude'))?.claude ?? {}
        return {
          configDir: claude.CLAUDE_CONFIG_DIR ?? '',
          envPatch: { ...claude },
          provenance: 'desktop-host-launch-env'
        }
      }
    }
  }

  /** Refused where this host has account services of its own: they already decide every launch. */
  setHostLaunchEnv(launchEnv: HostAccountLaunchEnv): void {
    if (this.hasOwnAccountServices()) {
      throw new Error('This host manages its own provider accounts.')
    }
    const previous = this.hostLaunchEnv
    this.hostLaunchEnv = launchEnv
    if (JSON.stringify(previous) !== JSON.stringify(launchEnv)) {
      agentModelCatalogStore.expireLaunchScopes(
        (agent) =>
          previous?.wslDistro !== this.hostLaunchEnv?.wslDistro ||
          JSON.stringify(Object.entries(hostAccountLaunchEnvFor(previous, agent)).sort()) !==
            JSON.stringify(Object.entries(this.hostLaunchEnvFor(agent)).sort())
      )
      retireAtRestCommandContext()
    }
    this.firstHostLaunchEnv.settle()
    try {
      this.persistHostLaunchEnv?.(launchEnv)
    } catch (error) {
      // Environment already applies; persistence failure loses it only on restart before the next push.
      console.warn('[accounts] Could not save the host account env:', error)
    }
  }

  /** orcad's store: starts from the last pushed env, so launches before a reconnect keep it. */
  restoreHostLaunchEnv(
    saved: HostAccountLaunchEnv | null,
    persist: (launchEnv: HostAccountLaunchEnv) => void,
    options: { expectDesktopPush?: boolean; refreshClaudeProfile?: HostClaudeProfileRefresh } = {}
  ): void {
    this.persistHostLaunchEnv = persist
    if (this.hasOwnAccountServices()) {
      return
    }
    this.refreshClaudeProfile = options.refreshClaudeProfile ?? null
    if (saved) {
      const previous = this.hostLaunchEnv
      this.hostLaunchEnv = saved
      if (JSON.stringify(previous) !== JSON.stringify(saved)) {
        agentModelCatalogStore.expireLaunchScopes(
          (agent) =>
            previous?.wslDistro !== this.hostLaunchEnv?.wslDistro ||
            JSON.stringify(Object.entries(hostAccountLaunchEnvFor(previous, agent)).sort()) !==
              JSON.stringify(Object.entries(this.hostLaunchEnvFor(agent)).sort())
        )
        retireAtRestCommandContext()
      }
      return
    }
    if (options.expectDesktopPush) {
      this.firstHostLaunchEnv.arm()
    }
  }

  /** Before a launch for `agent` this host starts: a fresh WSL host's first account push (once,
   *  briefly), then a refresh of the selected Claude folder, as the desktop's launches do. */
  async prepareHostAgentLaunch(agent: string | null | undefined): Promise<void> {
    await this.firstHostLaunchEnv.wait()
    if (agent === 'claude' && this.refreshClaudeProfile) {
      await refreshSelectedClaudeProfile(this.refreshClaudeProfile, () => this.hostLaunchEnv)
    }
  }

  /** The desktop-selected account env for a process `agent` starts here; empty when none. */
  hostLaunchEnvFor(agent: string | null | undefined): Readonly<Record<string, string>> {
    return hostAccountLaunchEnvFor(this.hostLaunchEnv, agent)
  }
}
