import { rmSync } from 'node:fs'
import type { AgentHookSource } from '../../shared/agent-hook-relay'
import type { SFTPWrapper } from 'ssh2'
import type { AgentHookInstallState, AgentHookInstallStatus } from '../../shared/agent-hook-types'
import {
  buildManagedCommandHook,
  readHooksJson,
  writeHooksJson,
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
  getWindowsClaudeHookFileStatus,
  installWindowsClaudeHookFiles,
  refreshWindowsClaudeHookFiles
} from './windows-hook-files'

export { getManagedScript }
import { getManagedStatusLineScript } from './statusline-script'
import { installManagedStatusLine, retireManagedStatusLine } from './claude-managed-statusline'
import { profileTargetsDefaultHome } from './claude-profile-hook-target'
import {
  applyManagedHooks,
  CLAUDE_HOOK_SETTINGS,
  getManagedScriptFileName,
  getConfigPath,
  getManagedLifecycleHook,
  getManagedScriptPath,
  getPosixManagedScriptFileName,
  getRemoteConfigPath,
  getRemoteManagedCommand,
  getStatusLineInstallMarkerPath,
  getStatusLineScriptFileName,
  getStatusLineScriptPath,
  hasSameManagedHookInvocation,
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
  /** A Claude-compatible CLI with its own settings file writes a fixed plan, not Claude's version table. */
  hookPlan?: ClaudeManagedHookPlan
}

type ClaudeHookInstallOptions = {
  claudeVersion?: string
}

type ClaudeHookTargetOptions = ClaudeHookInstallOptions & {
  /** Explicit managed profile on this host; omitted for the existing default-home behavior. */
  configDir?: string
  /** The home whose default settings a profile follows; defaults to os.homedir(). */
  userHome?: string
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
      skipWhenGrokImportsClaude: this.options.agent === 'claude'
    })
  }

  // Why: Claude's settings loader rejects events newer than the running CLI, so its plan follows the
  // resolved version; OpenClaude and Qoder read their own settings files.
  private managedHookPlan(options: ClaudeHookInstallOptions): ClaudeManagedHookPlan {
    return this.options.agent === 'claude'
      ? getClaudeManagedHookPlan(options.claudeVersion)
      : (this.options.hookPlan ?? OPENCLAUDE_MANAGED_HOOK_PLAN)
  }

  // Why: a profile destination that is, or links into, the default home would edit System Default's hooks.
  private refuseDefaultHome(options: ClaudeHookTargetOptions): AgentHookInstallStatus | null {
    const { configDir, userHome } = options
    if (
      configDir === undefined ||
      !profileTargetsDefaultHome(this.options.settings, configDir, userHome)
    ) {
      return null
    }
    return {
      agent: this.options.agent,
      state: 'error',
      configPath: getConfigPath(this.options.settings, configDir),
      managedHooksPresent: false,
      detail: 'Profile settings resolve to the default home'
    }
  }

  getStatus(options: ClaudeHookTargetOptions = {}): AgentHookInstallStatus {
    const refused = this.refuseDefaultHome(options)
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

    // Why: report partial registration instead of a false installed state.
    const expectedHook = getManagedLifecycleHook(scriptPath, this.options.settings)
    const missing: string[] = []
    let presentCount = 0
    for (const event of this.managedHookPlan(options).install) {
      const definitions = Array.isArray(config.hooks?.[event.eventName])
        ? config.hooks![event.eventName]!
        : []
      const hasCommand = definitions.some((definition) =>
        (definition.hooks ?? []).some((hook) => hasSameManagedHookInvocation(hook, expectedHook))
      )
      if (hasCommand) {
        presentCount += 1
      } else {
        missing.push(event.eventName)
      }
    }
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
    return this.usesWindowsEntry ? getWindowsClaudeHookFileStatus(status, scriptPath) : status
  }

  async refreshManagedScripts(): Promise<void> {
    const scriptPath = getManagedScriptPath(this.options.settings)
    const payload = this.managedScript()
    await (this.usesWindowsEntry
      ? refreshWindowsClaudeHookFiles(scriptPath, payload)
      : refreshManagedScriptIfPresent(scriptPath, payload))
    // Why: no agent gate — the statusline script only ever exists for claude, so presence is the gate.
    await refreshManagedScriptIfPresent(
      getStatusLineScriptPath(this.options.settings),
      getManagedStatusLineScript('local')
    )
  }

  install(options: ClaudeHookTargetOptions = {}): AgentHookInstallStatus {
    const refused = this.refuseDefaultHome(options)
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

    const hook = getManagedLifecycleHook(scriptPath, this.options.settings)
    const plan = this.managedHookPlan(options)
    let nextConfig = applyManagedHooks(
      config,
      hook,
      getManagedScriptFileName(this.options.settings),
      plan
    )
    const payload = this.managedScript()
    if (this.usesWindowsEntry) {
      installWindowsClaudeHookFiles(scriptPath, payload)
    } else {
      writeManagedScript(scriptPath, payload)
    }
    if (plan.statusLine === 'install') {
      nextConfig = installManagedStatusLine(
        this.options.settings,
        nextConfig,
        options.configDir,
        options.userHome
      )
    } else if (plan.statusLine === 'retire') {
      nextConfig = retireManagedStatusLine(this.options.settings, nextConfig, options.configDir)
    }
    writeHooksJson(configPath, nextConfig)
    return this.getStatus(options)
  }

  // Why: install the Claude hook on the remote box (via SFTP); POSIX-only by design (Windows-remote deferred).
  async installRemote(
    sftp: SFTPWrapper,
    remoteHome: string,
    // Why: remote settings live at the remote default home; a profile destination must not be silently dropped.
    options: ClaudeHookInstallOptions & { configDir?: never } = {}
  ): Promise<AgentHookInstallStatus> {
    // Why: remote Windows is unsupported; local process.platform cannot identify the remote OS.
    const remoteConfigPath = getRemoteConfigPath(remoteHome, this.options.settings)
    const remoteScriptFileName = getPosixManagedScriptFileName(this.options.settings)
    const remoteScriptPath = `${remoteHome.replace(/\/$/, '')}/.orca/agent-hooks/${remoteScriptFileName}`
    // Why: surface fallible SFTP installs as structured errors.
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

      // Why: settings resolve HOME at runtime while SFTP still targets the discovered remote home.
      const hook = buildManagedCommandHook(getRemoteManagedCommand(remoteScriptPath))
      const nextConfig = applyManagedHooks(
        config,
        hook,
        remoteScriptFileName,
        this.managedHookPlan(options)
      )

      // Why: write scripts before settings to avoid settings pointing to missing scripts.
      // Why: SSH scripts always use POSIX .sh paths, regardless of the local OS.
      await writeManagedScriptRemote(sftp, remoteScriptPath, this.managedScript('posix'))
      // Why: no statusline install here — this path serves SSH remotes and WSL guests, whose relay hook
      // listener doesn't route /statusline/claude, and an SSH box's Claude login can be a different
      // account than the locally selected one, so its usage must not feed the local bar (live feed is host-local only).
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

  remove(options: Omit<ClaudeHookTargetOptions, 'claudeVersion'> = {}): AgentHookInstallStatus {
    const refused = this.refuseDefaultHome(options)
    if (refused) {
      return refused
    }
    const configPath = getConfigPath(this.options.settings, options.configDir)
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
        // Why: an Orca-level uninstall resets the opt-out memory so a later re-enable installs the statusline again.
        rmSync(getStatusLineInstallMarkerPath(this.options.settings, options.configDir), {
          force: true
        })
      } catch {
        // ignore — marker cleanup is best-effort
      }
    }
    return this.getStatus(options)
  }
}

export const claudeHookService = new ClaudeHookService()
