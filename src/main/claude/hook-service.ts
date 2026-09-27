import { existsSync, rmSync, writeFileSync } from 'node:fs'
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
import {
  managedScriptExists,
  refreshManagedScriptIfPresent,
  restoreManagedScript
} from '../agent-hooks/managed-hook-script-refresh'
import { getManagedScript, getManagedWindowsLauncherScript } from './hook-script'

export { getManagedScript }
import { getManagedStatusLineScript } from './statusline-script'
import {
  applyManagedHooks,
  applyManagedStatusLine,
  CLAUDE_EVENTS,
  CLAUDE_HOOK_SETTINGS,
  getManagedScriptFileName,
  getManagedImplScriptFileName,
  getManagedImplScriptPath,
  getConfigPath,
  getManagedCommand,
  getManagedLifecycleHook,
  getManagedScriptPath,
  getPosixManagedScriptFileName,
  getRemoteConfigPath,
  getRemoteManagedCommand,
  getStatusLineInstallMarkerPath,
  getStatusLineScriptFileName,
  getStatusLineScriptPath,
  getStatusLineSlotState,
  hasSameManagedHookInvocation,
  removeManagedHooks,
  removeManagedStatusLine,
  type ClaudeCompatibleHookSettings
} from './hook-settings'

type ClaudeHookServiceOptions = {
  agent: AgentHookInstallStatus['agent']
  displayName: string
  settings: ClaudeCompatibleHookSettings
}

type ClaudeHookInstallOptions = {
  claudeVersion?: string
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

  getStatus(): AgentHookInstallStatus {
    const configPath = getConfigPath(this.options.settings)
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
    for (const event of CLAUDE_EVENTS) {
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
    return { agent: this.options.agent, state, configPath, managedHooksPresent, detail }
  }

  async refreshManagedScripts(): Promise<void> {
    const payload = getManagedScript('local', {
      skipWhenDevinImportsClaude: this.options.agent === 'claude',
      skipWhenGrokImportsClaude: this.options.agent === 'claude'
    })
    if (process.platform === 'win32' && this.options.settings.usesWindowsCompatLauncher) {
      const scriptPath = getManagedScriptPath(this.options.settings)
      const implPath = getManagedImplScriptPath(this.options.settings)
      const implPresent = await refreshManagedScriptIfPresent(implPath, payload)
      const launcherPresent = await managedScriptExists(scriptPath)
      // Why (#21514): a launcher without its impl answers {} for every event —
      // healthy-looking but dead. The impl must land before the launcher is
      // rewritten, or a pre-launcher install is observed — and stranded, if the
      // impl write fails — in exactly that masked state.
      if (launcherPresent && !implPresent) {
        await restoreManagedScript(implPath, payload)
      }
      await refreshManagedScriptIfPresent(
        scriptPath,
        getManagedWindowsLauncherScript(getManagedImplScriptFileName(this.options.settings))
      )
    } else {
      await refreshManagedScriptIfPresent(getManagedScriptPath(this.options.settings), payload)
    }
    // Why: no agent gate — the statusline script only ever exists for claude, so presence is the gate.
    await refreshManagedScriptIfPresent(
      getStatusLineScriptPath(this.options.settings),
      getManagedStatusLineScript('local')
    )
  }

  install(options: ClaudeHookInstallOptions = {}): AgentHookInstallStatus {
    const configPath = getConfigPath(this.options.settings)
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
    let nextConfig = applyManagedHooks(
      config,
      hook,
      getManagedScriptFileName(this.options.settings),
      this.options.agent === 'claude' ? options : undefined
    )
    const payload = getManagedScript('local', {
      skipWhenDevinImportsClaude: this.options.agent === 'claude',
      skipWhenGrokImportsClaude: this.options.agent === 'claude'
    })
    if (process.platform === 'win32' && this.options.settings.usesWindowsCompatLauncher) {
      // Why (#21514): the registered script is a thin launcher; the impl is
      // written first so a live launcher never observes its own {} fallback.
      writeManagedScript(getManagedImplScriptPath(this.options.settings), payload)
      writeManagedScript(
        scriptPath,
        getManagedWindowsLauncherScript(getManagedImplScriptFileName(this.options.settings))
      )
    } else {
      writeManagedScript(scriptPath, payload)
    }
    // Why: the statusline usage feed is Claude-only — OpenClaude data would be misattributed to the Claude provider.
    if (this.options.agent === 'claude') {
      nextConfig = this.installManagedStatusLine(nextConfig)
    }
    writeHooksJson(configPath, nextConfig)
    return this.getStatus()
  }

  // Why: the statusline feed is opportunistic (usage display, not agent status); a user who deleted the
  // managed entry has opted out, and the marker distinguishes that deletion from a first install.
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
      getManagedCommand(statusLineScriptPath),
      scriptFileName
    )
    try {
      writeFileSync(markerPath, '')
    } catch {
      // Best-effort: a missing marker only means one future user deletion gets re-installed once.
    }
    return next
  }

  // Why: install the Claude hook on the remote box (via SFTP); POSIX-only by design (Windows-remote deferred).
  async installRemote(
    sftp: SFTPWrapper,
    remoteHome: string,
    options: ClaudeHookInstallOptions = {}
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
        this.options.agent === 'claude' ? options : undefined
      )

      // Why: write scripts before settings to avoid settings pointing to missing scripts.
      // Why: SSH scripts always use POSIX .sh paths, regardless of the local OS.
      await writeManagedScriptRemote(
        sftp,
        remoteScriptPath,
        getManagedScript('posix', {
          skipWhenDevinImportsClaude: this.options.agent === 'claude',
          skipWhenGrokImportsClaude: this.options.agent === 'claude'
        })
      )
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
        // Why: an Orca-level uninstall resets the opt-out memory so a later re-enable installs the statusline again.
        rmSync(getStatusLineInstallMarkerPath(this.options.settings), { force: true })
      } catch {
        // ignore — marker cleanup is best-effort
      }
    }
    return this.getStatus()
  }
}

export const claudeHookService = new ClaudeHookService()
