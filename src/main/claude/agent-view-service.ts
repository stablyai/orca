import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { getAppEnvironment } from '../../shared/app-environment'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { isAgentStatusHooksEnabledForAgent } from '../../shared/agent-status-hooks-setting'
import { getAgentLaunchExecutableName } from '../../shared/agent-command-line-intent'
import { withTimeout } from '../../shared/promise-timeout-fallback'
import type { TuiAgent } from '../../shared/tui-agent'
import { listClaudeProfileHomesAsync } from '../claude-accounts/claude-profile-homes'
import { resolveLoginShellEnvironment } from '../startup/login-shell-environment'
import { reconcileClaudeAgentViewConfig } from './agent-view-config'
import { ensureClaudeAgentViewPluginAsync } from './agent-view-plugin'

type NavigationSettings = Partial<
  Pick<
    GlobalSettings,
    | 'claudeSubagentNavigationEnabled'
    | 'agentStatusHooksEnabled'
    | 'disabledTuiAgents'
    | 'agentDefaultEnv'
  >
>

type ServiceDeps = {
  reconcileConfig: typeof reconcileClaudeAgentViewConfig
  ensurePlugin: typeof ensureClaudeAgentViewPluginAsync
  listProfiles: typeof listClaudeProfileHomesAsync
  loginEnv: typeof resolveLoginShellEnvironment
}

export class ClaudeAgentViewService {
  private tail: Promise<void> = Promise.resolve()
  private key?: string
  private generation = 0
  private enabled = false
  private pluginRoot?: string
  private readonly configs = new Set<string>()
  private defaultConfig = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')

  constructor(
    private readonly userDataPath: string,
    private readonly deps: ServiceDeps = {
      reconcileConfig: reconcileClaudeAgentViewConfig,
      ensurePlugin: ensureClaudeAgentViewPluginAsync,
      listProfiles: listClaudeProfileHomesAsync,
      loginEnv: resolveLoginShellEnvironment
    }
  ) {}

  reconcile(settings: NavigationSettings): Promise<void> {
    const enabled =
      settings.claudeSubagentNavigationEnabled !== false &&
      isAgentStatusHooksEnabledForAgent(settings, 'claude')
    const customConfig = settings.agentDefaultEnv?.claude?.CLAUDE_CONFIG_DIR
    const key = JSON.stringify([enabled, customConfig])
    if (key === this.key) {
      return this.tail
    }
    this.key = key
    this.enabled = enabled
    this.pluginRoot = undefined
    const generation = ++this.generation
    return this.enqueue(async () => {
      const env = enabled ? await this.deps.loginEnv() : process.env
      const cachedEnv = enabled ? undefined : await this.deps.loginEnv({ cachedOnly: true })
      this.defaultConfig =
        env.CLAUDE_CONFIG_DIR || process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
      for (const dir of [
        this.defaultConfig,
        cachedEnv?.CLAUDE_CONFIG_DIR,
        customConfig,
        ...(await this.deps.listProfiles(this.userDataPath))
      ]) {
        if (dir) {
          this.configs.add(resolve(dir))
        }
      }
      for (const dir of this.configs) {
        await this.deps.reconcileConfig(join(dir, 'settings.json'), enabled)
      }
      const root = enabled ? await this.deps.ensurePlugin(this.userDataPath) : undefined
      if (generation === this.generation) {
        this.pluginRoot = root
      }
    })
  }

  prepareProfile(configDir: string): Promise<void> {
    const dir = resolve(configDir)
    if (this.configs.has(dir)) {
      return this.tail
    }
    this.configs.add(dir)
    return this.enqueue(() => this.deps.reconcileConfig(join(dir, 'settings.json'), this.enabled))
  }

  ready(): Promise<void> {
    return this.tail
  }

  async readyForLaunch(args: {
    settings?: NavigationSettings
    isWsl?: boolean
    launchAgent?: TuiAgent
    launchCommand?: string
  }): Promise<void> {
    if (
      args.settings?.claudeSubagentNavigationEnabled === false ||
      !isAgentStatusHooksEnabledForAgent(args.settings, 'claude') ||
      args.isWsl ||
      (args.launchAgent
        ? args.launchAgent !== 'claude'
        : getAgentLaunchExecutableName(args.launchCommand) !== 'claude')
    ) {
      return
    }
    await withTimeout(this.tail, 200, undefined)
  }

  read(configDir = this.defaultConfig): { pluginDir: string; configDir: string } | undefined {
    return this.pluginRoot && this.configs.has(resolve(configDir))
      ? { pluginDir: this.pluginRoot, configDir }
      : undefined
  }

  private enqueue(run: () => Promise<void>): Promise<void> {
    this.tail = this.tail.then(run).catch((error: unknown) => {
      this.key = undefined
      console.warn('[agent-hooks] Claude subagent navigation reconciliation failed', error)
    })
    return this.tail
  }
}

const services = new Map<string, ClaudeAgentViewService>()

export function getClaudeAgentViewService(
  userDataPath = getAppEnvironment().getPath('userData')
): ClaudeAgentViewService {
  let service = services.get(userDataPath)
  if (!service) {
    service = new ClaudeAgentViewService(userDataPath)
    services.set(userDataPath, service)
  }
  return service
}
