import { existsSync, rmSync, writeFileSync } from 'node:fs'
import type { SFTPWrapper } from 'ssh2'
import type { AgentHookInstallState, AgentHookInstallStatus } from '../../shared/agent-hook-types'
import {
  readHooksJson,
  updateHooksJsonWithRetry,
  writeManagedScript,
  type HooksConfig
} from '../agent-hooks/installer-utils'
import {
  readHooksJsonRemote,
  writeHooksJsonRemote,
  writeManagedScriptRemote
} from '../agent-hooks/installer-utils-remote'
import { getManagedScript } from './managed-hook-script'
import { getManagedStatusLineScript } from './statusline-script'
import {
  applyManagedHooks,
  applyManagedStatusLine,
  CLAUDE_EVENTS,
  CLAUDE_HOOK_SETTINGS,
  getManagedScriptFileName,
  getConfigPath,
  getManagedCommand,
  getManagedScriptPath,
  getPosixManagedScriptFileName,
  getRemoteConfigPath,
  getRemoteManagedCommand,
  getStatusLineInstallMarkerPath,
  getStatusLineScriptFileName,
  getStatusLineScriptPath,
  getStatusLineSlotState,
  removeManagedHooks,
  removeManagedStatusLine,
  type ClaudeCompatibleHookSettings
} from './hook-settings'
import { isClaudeFlavorConfigDirName } from './claude-config-dir-discovery'

type ClaudeHookServiceOptions = {
  agent: AgentHookInstallStatus['agent']
  displayName: string
  settings: ClaudeCompatibleHookSettings
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

    // Why: report `partial` when only some events are registered so the sidebar shows a degraded install, not a false-positive `installed`.
    const command = getManagedCommand(scriptPath)
    const missing: string[] = []
    let presentCount = 0
    for (const event of CLAUDE_EVENTS) {
      const definitions = Array.isArray(config.hooks?.[event.eventName])
        ? config.hooks![event.eventName]!
        : []
      const hasCommand = definitions.some((definition) =>
        (definition.hooks ?? []).some((hook) => hook.command === command)
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

  install(): AgentHookInstallStatus {
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

    const command = getManagedCommand(scriptPath)
    writeManagedScript(
      scriptPath,
      getManagedScript('local', { skipWhenDevinImportsClaude: this.options.agent === 'claude' })
    )
    // Why: settings.json is also rewritten by the CLI itself; the retry helper
    // re-merges on concurrent change instead of clobbering it (last-writer-wins
    // previously lost keys written between our read and our replace).
    let retryOutcome: 'unparseable' | 'retry-exhausted' | null = null
    const updated = updateHooksJsonWithRetry(
      configPath,
      (current) => {
        let nextConfig = applyManagedHooks(
          current,
          command,
          getManagedScriptFileName(this.options.settings)
        )
        // Why: the statusline usage feed is Claude-only — OpenClaude data would be misattributed to the Claude provider.
        if (this.options.agent === 'claude') {
          nextConfig = this.installManagedStatusLine(nextConfig)
        }
        return nextConfig
      },
      3,
      (outcome) => {
        retryOutcome = outcome
      }
    )
    if (!updated) {
      return {
        agent: this.options.agent,
        state: 'error',
        configPath,
        managedHooksPresent: false,
        detail:
          retryOutcome === 'retry-exhausted'
            ? `${this.options.displayName} settings.json keeps changing under us — retry`
            : `Could not parse ${this.options.displayName} settings.json`
      }
    }
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
  async installRemote(sftp: SFTPWrapper, remoteHome: string): Promise<AgentHookInstallStatus> {
    // Why: remote-Windows is out of scope; ship POSIX paths. process.platform here is the local box, not the remote, so it can't gate this.
    const remoteConfigPath = getRemoteConfigPath(remoteHome, this.options.settings)
    const remoteScriptFileName = getPosixManagedScriptFileName(this.options.settings)
    const remoteScriptPath = `${remoteHome.replace(/\/$/, '')}/.orca/agent-hooks/${remoteScriptFileName}`
    // Why: SFTP I/O fails often (network/EACCES/disk); wrap install so transient failures surface as structured state:'error' rather than an unhandled rejection.
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

      // Why: the POSIX wrapper is identical regardless of where the script lands; only the path differs.
      const command = getRemoteManagedCommand(remoteScriptPath)
      const nextConfig = applyManagedHooks(config, command, remoteScriptFileName)

      // Why: write script before settings — a mid-install failure then leaves a harmless orphan script, not settings.json pointing at a missing one.
      // Why: SSH remotes use POSIX `.sh` paths even when Orca runs on Windows; never derive remote script syntax from the local OS.
      await writeManagedScriptRemote(
        sftp,
        remoteScriptPath,
        getManagedScript('posix', { skipWhenDevinImportsClaude: this.options.agent === 'claude' })
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
    // Why: same stale-check as install() — a concurrent CLI settings write
    // between our read and replace must be re-merged, not overwritten. The
    // null return keeps the no-op guarantee: nothing managed present means no
    // write at all (no file/dir creation, no reformat, no .bak roll).
    let retryOutcome: 'unparseable' | 'retry-exhausted' | null = null
    const updated = updateHooksJsonWithRetry(
      configPath,
      (current) => {
        const { config: hooksRemoved, changed: hooksChanged } = removeManagedHooks(
          current,
          getManagedScriptFileName(this.options.settings)
        )
        const { config: nextConfig, changed: statusLineChanged } = removeManagedStatusLine(
          hooksRemoved,
          getStatusLineScriptFileName(this.options.settings)
        )
        return hooksChanged || statusLineChanged ? nextConfig : null
      },
      3,
      (outcome) => {
        retryOutcome = outcome
      }
    )
    if (!updated) {
      return {
        agent: this.options.agent,
        state: 'error',
        configPath,
        managedHooksPresent: false,
        detail:
          retryOutcome === 'retry-exhausted'
            ? `${this.options.displayName} settings.json keeps changing under us — retry`
            : `Could not parse ${this.options.displayName} settings.json`
      }
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

/** Service for a discovered `~/.claude-<name>` / `~/.claude.<name>` config
 *  dir. Same agent id and shared claude-hook script — these dirs run genuine
 *  claude posting to /hook/claude; only the settings.json location differs. */
export function createClaudeConfigDirHookService(configDirName: string): ClaudeHookService {
  if (!isClaudeFlavorConfigDirName(configDirName)) {
    // Why: this value becomes a home-relative write path, so validate it again at the factory boundary.
    throw new Error('Invalid Claude config-dir name')
  }
  return new ClaudeHookService({
    agent: 'claude',
    displayName: 'Claude',
    settings: { configDirName, scriptBaseName: 'claude-hook' }
  })
}
