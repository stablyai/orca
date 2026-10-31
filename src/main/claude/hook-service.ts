import { getAppEnvironment } from '../../shared/app-environment'
import {
  listClaudeProfileHomes,
  listClaudeProfileHomesAsync
} from '../claude-accounts/claude-profile-homes'
import type { AgentHookSource } from '../../shared/agent-hook-relay'
import type { SFTPWrapper } from 'ssh2'
import type { AgentHookInstallStatus } from '../../shared/agent-hook-types'
import {
  buildManagedCommandHook,
  readHooksJson,
  writeHooksJson,
  writeManagedScript,
  type HooksConfig
} from '../agent-hooks/installer-utils'
import {
  readHooksJsonRemote,
  writeHooksJsonRemote,
  writeManagedScriptRemote
} from '../agent-hooks/installer-utils-remote'
import { refreshManagedScriptIfPresent } from '../agent-hooks/managed-hook-script-refresh'
import { getManagedScript } from './hook-script'
import {
  removeClaudeAgentViewRemote,
  refreshClaudeAgentView,
  removeClaudeAgentView
} from './agent-view-install'
import {
  installWindowsClaudeHookExecutable,
  installWindowsClaudeHookFiles,
  refreshWindowsClaudeHookFiles
} from './windows-hook-files'

export { getManagedScript }
import { getManagedStatusLineScript } from './statusline-script'
import { installClaudeSystemHooks, removeClaudeSystemHooks } from './statusline-install'
import { getClaudeHookStatus } from './claude-hook-status'
import { removeClaudeHookSettings } from './claude-hook-removal'
import {
  systemClaudeHookTarget,
  type ClaudeHookTarget,
  type SystemClaudeHookTarget
} from './claude-hook-target'
import { refuseProfileAtDefaultHome } from './claude-profile-hook-target'
import {
  applyManagedHooks,
  CLAUDE_HOOK_SETTINGS,
  getManagedScriptFileName,
  getConfigPath,
  getManagedEventHook,
  getManagedScriptPath,
  getPosixManagedScriptFileName,
  getRemoteConfigPath,
  getRemoteManagedEventCommand,
  getStatusLineScriptPath,
  type ClaudeCompatibleHookSettings
} from './hook-settings'
import { claudeAcceptsExecFormHooks } from './claude-hook-event-versions'
import {
  getClaudeManagedHookPlan,
  OPENCLAUDE_MANAGED_HOOK_PLAN,
  type ClaudeManagedHookPlan
} from './claude-managed-hook-events'

type ClaudeHookServiceOptions = {
  agent: AgentHookInstallStatus['agent']
  displayName: string
  settings: ClaudeCompatibleHookSettings
  source?: AgentHookSource
  hookPlan?: ClaudeManagedHookPlan
}

type ClaudeHookInstallOptions = {
  claudeVersion?: string
}

type ClaudeHookTargetOptions = ClaudeHookInstallOptions & {
  target?: ClaudeHookTarget
}

const DEFAULT_CLAUDE_HOOK_SERVICE_OPTIONS: ClaudeHookServiceOptions = {
  agent: 'claude',
  displayName: 'Claude',
  settings: CLAUDE_HOOK_SETTINGS
}

export class ClaudeHookService {
  private readonly options: ClaudeHookServiceOptions

  constructor(options: ClaudeHookServiceOptions = DEFAULT_CLAUDE_HOOK_SERVICE_OPTIONS) {
    this.options = options
  }

  private get usesWindowsEntry(): boolean {
    return process.platform === 'win32' && this.options.agent === 'claude'
  }

  private managedScript(target: 'local' | 'posix' = 'local'): string {
    return getManagedScript(target, {
      source: this.options.source,
      skipWhenDevinImportsClaude: this.options.agent === 'claude',
      skipWhenGrokImportsClaude: this.options.agent === 'claude',
      skipWhenCursorImportsClaude: this.options.agent === 'claude'
    })
  }

  // Claude version-gates hook events; compatible CLIs use their own fixed plans.
  private managedHookPlan(options: ClaudeHookInstallOptions): ClaudeManagedHookPlan {
    return this.options.agent === 'claude'
      ? getClaudeManagedHookPlan(options.claudeVersion)
      : (this.options.hookPlan ?? OPENCLAUDE_MANAGED_HOOK_PLAN)
  }

  getStatus(options: ClaudeHookTargetOptions = {}): AgentHookInstallStatus {
    const target =
      options.target ?? (this.options.agent === 'claude' ? systemClaudeHookTarget() : undefined)
    const refused = refuseProfileAtDefaultHome(this.options, target)
    if (refused) {
      return refused
    }
    return getClaudeHookStatus(
      this.options,
      target?.configDir,
      this.managedHookPlan(options),
      this.usesWindowsEntry
    )
  }

  async refreshManagedScripts(): Promise<void> {
    if (this.options.agent === 'claude') {
      const profiles = await listClaudeProfileHomesAsync(getAppEnvironment().getPath('userData'))
      for (const configDir of [undefined, ...profiles]) {
        await refreshClaudeAgentView(getConfigPath(this.options.settings, configDir)).catch(
          (error: unknown) => {
            console.warn('[agent-hooks] Claude agent view refresh failed', error)
          }
        )
      }
    }
    const scriptPath = getManagedScriptPath(this.options.settings)
    const payload = this.managedScript()
    await (this.usesWindowsEntry
      ? refreshWindowsClaudeHookFiles(scriptPath, payload)
      : refreshManagedScriptIfPresent(scriptPath, payload))
    // Refresh existing statusline scripts without creating new installs.
    await refreshManagedScriptIfPresent(
      getStatusLineScriptPath(this.options.settings),
      getManagedStatusLineScript('local')
    )
  }

  install(options: ClaudeHookTargetOptions = {}): AgentHookInstallStatus {
    const target =
      options.target ?? (this.options.agent === 'claude' ? systemClaudeHookTarget() : undefined)
    if (this.options.agent === 'claude' && target?.kind !== 'profile') {
      throw new Error('Native Claude System hooks require installSystem')
    }
    const refused = refuseProfileAtDefaultHome(this.options, target)
    if (refused) {
      return refused
    }
    const configPath = getConfigPath(this.options.settings, target?.configDir)
    const config = readHooksJson(configPath)
    if (!config) {
      return {
        agent: this.options.agent,
        state: 'error',
        configPath,
        managedHooksPresent: false,
        detail: `Could not parse ${this.options.displayName} settings.json`
      }
    }

    writeHooksJson(configPath, this.prepareHooks(options)(config))
    return this.getStatus(options)
  }

  installProfile(
    options: ClaudeHookInstallOptions & { target: Extract<ClaudeHookTarget, { kind: 'profile' }> }
  ): AgentHookInstallStatus {
    return this.install(options)
  }

  private prepareHooks(options: ClaudeHookInstallOptions): (config: HooksConfig) => HooksConfig {
    const scriptPath = getManagedScriptPath(this.options.settings)
    const plan = this.managedHookPlan(options)
    const exePath = this.usesWindowsEntry ? installWindowsClaudeHookExecutable(scriptPath) : null
    const execForm = claudeAcceptsExecFormHooks(options.claudeVersion)
    const definitions = new Map(
      plan.install.map(({ eventName }) => [
        eventName,
        getManagedEventHook(eventName, scriptPath, this.options.settings, exePath, { execForm })
      ])
    )
    if (this.usesWindowsEntry) {
      installWindowsClaudeHookFiles(scriptPath, this.managedScript())
    } else {
      writeManagedScript(scriptPath, this.managedScript())
    }
    const hookFor = (eventName: string) => definitions.get(eventName)!
    const scriptName = getManagedScriptFileName(this.options.settings)
    return (config) => applyManagedHooks(config, hookFor, scriptName, plan)
  }

  async installSystem(
    options: ClaudeHookInstallOptions & {
      target?: SystemClaudeHookTarget
      signal?: AbortSignal
      shouldContinue?: () => boolean
    } = {}
  ): Promise<AgentHookInstallStatus> {
    const target = options.target ?? systemClaudeHookTarget()
    try {
      options.signal?.throwIfAborted()
      if (options.shouldContinue?.() === false) {
        throw new Error('Claude hook installation was canceled')
      }
      const path = getConfigPath(this.options.settings, target.configDir)
      const plan = this.managedHookPlan(options)
      await installClaudeSystemHooks(path, plan, this.prepareHooks(options), options)
      return this.getStatus({ ...options, target })
    } catch (error) {
      return { ...this.getStatus({ ...options, target }), state: 'error', detail: String(error) }
    }
  }

  async removeSystem(
    options: {
      target?: SystemClaudeHookTarget
      signal?: AbortSignal
      shouldContinue?: () => boolean
    } = {}
  ): Promise<AgentHookInstallStatus> {
    const target = options.target ?? systemClaudeHookTarget()
    let failure: unknown
    try {
      await removeClaudeSystemHooks(getConfigPath(this.options.settings, target.configDir), options)
    } catch (error) {
      failure = error
    }
    this.removeAgentViews()
    const status = this.getStatus({ target })
    return failure ? { ...status, state: 'error', detail: String(failure) } : status
  }

  private removeAgentViews(): void {
    for (const configDir of [
      undefined,
      ...listClaudeProfileHomes(getAppEnvironment().getPath('userData'))
    ]) {
      removeClaudeAgentView(getConfigPath(this.options.settings, configDir))
    }
  }

  async installRemote(
    sftp: SFTPWrapper,
    remoteHome: string,
    options: ClaudeHookInstallOptions & { configDir?: string } = {}
  ): Promise<AgentHookInstallStatus> {
    // Remote hook installation targets POSIX hosts regardless of the client platform.
    const remoteConfigPath = options.configDir
      ? `${options.configDir.replace(/\/$/, '')}/settings.json`
      : getRemoteConfigPath(remoteHome, this.options.settings)
    const remoteScriptFileName = getPosixManagedScriptFileName(this.options.settings)
    const remoteScriptPath = `${remoteHome.replace(/\/$/, '')}/.orca/agent-hooks/${remoteScriptFileName}`
    try {
      const config = await readHooksJsonRemote(sftp, remoteConfigPath)
      if (!config) {
        return {
          agent: this.options.agent,
          state: 'error',
          configPath: remoteConfigPath,
          managedHooksPresent: false,
          detail: `Could not parse remote ${this.options.displayName} settings.json`
        }
      }

      // Settings resolve HOME at runtime; SFTP writes to the discovered remote home.
      const nextConfig = applyManagedHooks(
        config,
        (eventName) =>
          buildManagedCommandHook(getRemoteManagedEventCommand(eventName, remoteScriptPath)),
        remoteScriptFileName,
        this.managedHookPlan(options)
      )

      // Publish scripts before settings can reference them.
      await writeManagedScriptRemote(sftp, remoteScriptPath, this.managedScript('posix'))
      // Remote relays lack the statusline route, and remote account usage cannot be attributed locally.
      await writeHooksJsonRemote(sftp, remoteConfigPath, nextConfig)
      if (this.options.agent === 'claude') {
        await removeClaudeAgentViewRemote(sftp, remoteConfigPath).catch((error: unknown) => {
          console.warn('[agent-hooks] Remote Claude agent view migration failed', error)
        })
      }

      return {
        agent: this.options.agent,
        state: 'installed',
        configPath: remoteConfigPath,
        managedHooksPresent: true,
        detail: null
      }
    } catch (err) {
      return {
        agent: this.options.agent,
        state: 'error',
        configPath: remoteConfigPath,
        managedHooksPresent: false,
        detail: err instanceof Error ? err.message : String(err)
      }
    }
  }

  remove(options: { target?: SystemClaudeHookTarget } = {}): AgentHookInstallStatus {
    if (this.options.agent === 'claude') {
      throw new Error('Native Claude System hooks require removeSystem')
    }
    const target = options.target
    const configPath = getConfigPath(this.options.settings, target?.configDir)
    const paths = new Set([configPath])
    const errors = [...paths].flatMap((path) => {
      const error = removeClaudeHookSettings(this.options.settings, path)
      return error ? [error] : []
    })
    const status = this.getStatus({ target })
    return errors.length ? { ...status, state: 'error', detail: errors.join('; ') } : status
  }
}

export const claudeHookService = new ClaudeHookService()
