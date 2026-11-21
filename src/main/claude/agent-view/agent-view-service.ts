import { prewarmClaudeTerminalSideload } from './claude-terminal-sideload'
import { claudeConfigDirEnvPatch } from '../structured/launch/claude-config-dir-pin'
import { resolveStartupShell } from '../../../shared/agent-launch/startup/tui-agent-startup-shell'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { getAppEnvironment } from '../../../shared/app-lifecycle/app-environment'
import type { GlobalSettings } from '../../../shared/settings/global-settings-types'
import { isAgentStatusHooksEnabledForAgent } from '../../../shared/agent-hook-listener/configuration/agent-status-hooks-setting'
import { getAgentLaunchExecutableName } from '../../../shared/agent-launch/startup/agent-command-line-intent'
import { withTimeout } from '../../../shared/concurrency/promise-timeout-fallback'
import type { TuiAgent } from '../../../shared/agent-launch/catalog/tui-agent'
import { listClaudeProfileHomesAsync } from '../../claude-accounts/profiles/claude-profile-homes'
import { resolveLoginShellEnvironment } from '../../startup/shell-environment/login-shell-environment'
import { reconcileClaudeAgentViewConfig } from './agent-view-config'
import { ensureClaudeAgentViewPluginAsync } from './agent-view-plugin'
import { getManagedAgentHookTarget } from '../../../shared/agent-hook-listener/configuration/managed-agent-hook-targets'
import { detectLocalManagedAgentCliPresence } from '../../agent-hooks/installation/local-agent-cli-presence'

type NavigationSettings = Partial<
  Pick<
    GlobalSettings,
    | 'claudeSubagentNavigationEnabled'
    | 'agentStatusHooksEnabled'
    | 'disabledTuiAgents'
    | 'agentDefaultEnv'
    | 'agentCmdOverrides'
  >
>

type ServiceDeps = {
  reconcileConfig: typeof reconcileClaudeAgentViewConfig
  ensurePlugin: typeof ensureClaudeAgentViewPluginAsync
  listProfiles: typeof listClaudeProfileHomesAsync
  loginEnv: typeof resolveLoginShellEnvironment
  prewarm?: typeof prewarmClaudeTerminalSideload
  claudeOnPath: (settings: NavigationSettings) => Promise<boolean>
}

// Same presence rule as the managed Claude hooks: no Claude CLI, no writes to its config (#43445).
async function isClaudeOnPath(settings: NavigationSettings): Promise<boolean> {
  const target = getManagedAgentHookTarget('claude')
  if (!target) {
    return false
  }
  const presence = await detectLocalManagedAgentCliPresence([target], settings, {
    shouldHydrateShellPath: getAppEnvironment().isPackaged()
  })
  return presence.claude?.state === 'found'
}

export class ClaudeAgentViewService {
  private tail: Promise<void> = Promise.resolve()
  private key?: string
  private generation = 0
  private enabled = false
  private writesConfig = false
  private pluginRoot?: string
  private readonly configs = new Set<string>()
  private defaultConfig = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')

  constructor(
    private readonly userDataPath: string,
    private readonly deps: ServiceDeps = {
      reconcileConfig: reconcileClaudeAgentViewConfig,
      ensurePlugin: ensureClaudeAgentViewPluginAsync,
      listProfiles: listClaudeProfileHomesAsync,
      loginEnv: resolveLoginShellEnvironment,
      claudeOnPath: isClaudeOnPath,
      prewarm: prewarmClaudeTerminalSideload
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
      // Without Claude, leave its config untouched: neither add the binding nor remove one.
      const writesConfig = !enabled || (await this.deps.claudeOnPath(settings).catch(() => false))
      if (generation === this.generation) {
        this.writesConfig = writesConfig
      }
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
      for (const dir of writesConfig ? this.configs : []) {
        await this.deps.reconcileConfig(join(dir, 'settings.json'), enabled)
      }
      const root = enabled ? await this.deps.ensurePlugin(this.userDataPath) : undefined
      if (generation === this.generation) {
        this.pluginRoot = root
        if (root) {
          for (const dir of this.configs) {
            this.prewarm(dir, root, env)
          }
        }
      }
    })
  }

  prepareProfile(configDir: string): Promise<void> {
    const dir = resolve(configDir)
    if (this.configs.has(dir)) {
      return this.tail
    }
    this.configs.add(dir)
    return this.enqueue(async () => {
      if (this.writesConfig) {
        await this.deps.reconcileConfig(join(dir, 'settings.json'), this.enabled)
      }
      if (this.pluginRoot) {
        this.prewarm(dir, this.pluginRoot)
      }
    })
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

  private prewarm(configDir: string, root: string, captured?: NodeJS.ProcessEnv): void {
    void (async () => {
      const source = captured ?? (await this.deps.loginEnv())
      const env = Object.fromEntries(
        Object.entries(source).filter((entry): entry is [string, string] => entry[1] !== undefined)
      )
      Object.assign(env, claudeConfigDirEnvPatch(configDir, { env }), {
        ORCA_CLAUDE_AGENT_VIEW_PLUGIN_DIR: root,
        ORCA_CLAUDE_CONFIG_DIR: configDir
      })
      await this.deps.prewarm?.({
        env,
        command: 'claude',
        cwd: homedir(),
        shell: resolveStartupShell(process.platform)
      })
    })().catch(() => {})
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
