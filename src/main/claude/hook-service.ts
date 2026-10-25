import { existsSync, rmSync, writeFileSync } from 'node:fs'
import type { AgentHookSource } from '../../shared/agent-hook-relay'
import type { SFTPWrapper } from 'ssh2'
import type { AgentHookInstallState, AgentHookInstallStatus } from '../../shared/agent-hook-types'
import {
  buildManagedCommandHook,
  readHooksJson,
  writeHooksJson,
  type HooksConfig,
  writeManagedScript
} from '../agent-hooks/installer-utils'
import {
  readHooksJsonRemote,
  writeHooksJsonRemote,
  writeManagedScriptRemote
} from '../agent-hooks/installer-utils-remote'
import { refreshManagedScriptIfPresent } from '../agent-hooks/managed-hook-script-refresh'
import { getManagedScript } from './hook-script'
import {
  getWindowsClaudeHookExecutablePath,
  getWindowsClaudeHookFileStatus,
  installWindowsClaudeHookExecutable,
  installWindowsClaudeHookFiles,
  refreshWindowsClaudeHookFiles
} from './windows-hook-files'

export { getManagedScript }
import { getManagedStatusLineCommand, getManagedStatusLineScript } from './statusline-script'
import { refuseProfileAtDefaultHome } from './claude-profile-hook-target'
import {
  applyManagedHooks,
  applyManagedStatusLine,
  CLAUDE_HOOK_SETTINGS,
  getManagedScriptFileName,
  getConfigPath,
  getManagedEventHook,
  getManagedScriptPath,
  getPosixManagedScriptFileName,
  getRemoteConfigPath,
  getRemoteManagedEventCommand,
  getStatusLineInstallMarkerPath,
  getStatusLineScriptFileName,
  getStatusLineScriptPath,
  getStatusLineSlotState,
  findManagedEventHookForms,
  removeManagedHooks,
  removeManagedStatusLine,
  type ClaudeCompatibleHookSettings
} from './hook-settings'
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
  configDir?: string
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
    const refused = refuseProfileAtDefaultHome(this.options, options.configDir)
    if (refused) {
      return refused
    }
    const configPath = getConfigPath(this.options.settings, options.configDir)
    const scriptPath = getManagedScriptPath(this.options.settings)
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

    // Count either Windows launcher form: installation falls back to .cmd when the exe cannot be placed.
    const exePath = this.usesWindowsEntry ? getWindowsClaudeHookExecutablePath(scriptPath) : null
    const events = this.managedHookPlan(options).install.map((event) => event.eventName)
    const { missing, matchedForms } = findManagedEventHookForms(config, events, (eventName) =>
      [null, exePath].map((path) =>
        getManagedEventHook(eventName, scriptPath, this.options.settings, path)
      )
    )
    const presentCount = matchedForms.length
    const managedHooksPresent = presentCount > 0
    let state: AgentHookInstallState
    let detail: string | null
    if (missing.length === 0) {
      state = 'installed'
      detail = null
    } else if (presentCount === 0) {
      state = 'not_installed'
      detail = null
    } else {
      state = 'partial'
      detail = `Managed hook missing for events: ${missing.join(', ')}`
    }
    const status = { agent: this.options.agent, state, configPath, managedHooksPresent, detail }
    return this.usesWindowsEntry
      ? getWindowsClaudeHookFileStatus(status, scriptPath, matchedForms.includes(1))
      : status
  }

  async refreshManagedScripts(): Promise<void> {
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
    const refused = refuseProfileAtDefaultHome(this.options, options.configDir)
    if (refused) {
      return refused
    }
    const configPath = getConfigPath(this.options.settings, options.configDir)
    const scriptPath = getManagedScriptPath(this.options.settings)
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

    const plan = this.managedHookPlan(options)
    const exePath = this.usesWindowsEntry ? installWindowsClaudeHookExecutable(scriptPath) : null
    let nextConfig = applyManagedHooks(
      config,
      (eventName) => getManagedEventHook(eventName, scriptPath, this.options.settings, exePath),
      getManagedScriptFileName(this.options.settings),
      plan
    )
    const payload = this.managedScript()
    if (this.usesWindowsEntry) {
      installWindowsClaudeHookFiles(scriptPath, payload)
    } else {
      writeManagedScript(scriptPath, payload)
    }
    // Profiles inherit statusLine from the default-home settings copy.
    if (options.configDir === undefined && plan.statusLine === 'install') {
      nextConfig = this.installManagedStatusLine(nextConfig)
    } else if (options.configDir === undefined && plan.statusLine === 'retire') {
      nextConfig = this.retireManagedStatusLine(nextConfig)
    }
    writeHooksJson(configPath, nextConfig)
    return this.getStatus(options)
  }

  // The marker distinguishes a user-deleted statusline from a first install.
  private installManagedStatusLine(config: HooksConfig): HooksConfig {
    const scriptFileName = getStatusLineScriptFileName(this.options.settings)
    const markerPath = getStatusLineInstallMarkerPath(this.options.settings)
    const slot = getStatusLineSlotState(config, scriptFileName)
    if (slot === 'user' || (slot === 'empty' && existsSync(markerPath))) {
      return config
    }
    const statusLineScriptPath = getStatusLineScriptPath(this.options.settings)
    writeManagedScript(statusLineScriptPath, getManagedStatusLineScript('local'))
    const next = applyManagedStatusLine(
      config,
      getManagedStatusLineCommand(statusLineScriptPath),
      scriptFileName
    )
    try {
      writeFileSync(markerPath, '')
    } catch {
      // Marker failure may cause a later user deletion to be reinstalled.
    }
    return next
  }

  // Older CLIs reject statusLine; clear the marker so an upgrade can reinstall it.
  private retireManagedStatusLine(config: HooksConfig): HooksConfig {
    const { config: next, changed } = removeManagedStatusLine(
      config,
      getStatusLineScriptFileName(this.options.settings)
    )
    if (changed) {
      try {
        rmSync(getStatusLineInstallMarkerPath(this.options.settings), { force: true })
      } catch {
        // A stale marker can suppress reinstall after an upgrade.
      }
    }
    return next
  }

  async installRemote(
    sftp: SFTPWrapper,
    remoteHome: string,
    options: ClaudeHookInstallOptions = {}
  ): Promise<AgentHookInstallStatus> {
    // Remote hook installation targets POSIX hosts regardless of the client platform.
    const remoteConfigPath = getRemoteConfigPath(remoteHome, this.options.settings)
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

  remove(): AgentHookInstallStatus {
    const configPath = getConfigPath(this.options.settings)
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
    const { config: hooksRemoved, changed: hooksChanged } = removeManagedHooks(
      config,
      getManagedScriptFileName(this.options.settings)
    )
    const { config: nextConfig, changed: statusLineChanged } = removeManagedStatusLine(
      hooksRemoved,
      getStatusLineScriptFileName(this.options.settings)
    )
    if (hooksChanged || statusLineChanged) {
      writeHooksJson(configPath, nextConfig)
    }
    if (this.options.agent === 'claude') {
      try {
        // Explicit uninstall resets opt-out memory for a future re-enable.
        rmSync(getStatusLineInstallMarkerPath(this.options.settings), { force: true })
      } catch {
        // Marker cleanup is best-effort.
      }
    }
    return this.getStatus()
  }
}

export const claudeHookService = new ClaudeHookService()
