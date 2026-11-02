import { sftpOperation } from '../agent-hooks/sftp-operation'
import type { SFTPWrapper } from 'ssh2'
import type { AgentHookInstallStatus } from '../../shared/agent-hook-types'
import { buildManagedCommandHook } from '../agent-hooks/installer-utils'
import {
  readHooksJsonRemote,
  readTextFileRemote,
  writeHooksJsonRemote,
  writeManagedScriptRemote
} from '../agent-hooks/installer-utils-remote'
import { parseHooksJsonText } from '../agent-hooks/hooks-json-read'
import { removeClaudeAgentViewRemote } from './agent-view-install'
import {
  applyManagedHooks,
  removeManagedHooks,
  findManagedEventHookForms,
  getPosixManagedScriptFileName,
  getRemoteConfigPath,
  getRemoteManagedEventCommand,
  type ClaudeCompatibleHookSettings
} from './hook-settings'
import type { ClaudeManagedHookPlan } from './claude-managed-hook-events'

type RemoteOptions = { claudeVersion?: string; configDir?: string }

/** POSIX event-only lifecycle, independent of native System/statusline ownership. */
export class ClaudeRemoteHookService {
  constructor(
    private readonly options: {
      agent: AgentHookInstallStatus['agent']
      displayName: string
      settings: ClaudeCompatibleHookSettings
      script: () => string
      plan: (options: RemoteOptions) => ClaudeManagedHookPlan
    }
  ) {}
  async install(
    sftp: SFTPWrapper,
    remoteHome: string,
    options: RemoteOptions = {}
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
        this.options.plan(options)
      )

      // Publish scripts before settings can reference them.
      await writeManagedScriptRemote(sftp, remoteScriptPath, this.options.script())
      // Remote relays lack the statusline route, and remote account usage cannot be attributed locally.
      await writeHooksJsonRemote(sftp, remoteConfigPath, nextConfig)
      if (this.options.agent === 'claude') {
        await removeClaudeAgentViewRemote(sftp, remoteConfigPath).catch((error: unknown) => {
          console.warn('[agent-hooks] Remote Claude agent view migration failed', error)
        })
      }

      return await this.getStatus(sftp, remoteHome, options)
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

  async getStatus(
    sftp: SFTPWrapper,
    remoteHome: string,
    options: RemoteOptions = {}
  ): Promise<AgentHookInstallStatus> {
    const configPath = options.configDir
      ? `${options.configDir.replace(/\/$/, '')}/settings.json`
      : getRemoteConfigPath(remoteHome, this.options.settings)
    const scriptName = getPosixManagedScriptFileName(this.options.settings)
    const scriptPath = `${remoteHome.replace(/\/$/, '')}/.orca/agent-hooks/${scriptName}`
    try {
      const config = await readHooksJsonRemote(sftp, configPath)
      if (!config) {
        throw new Error(`Could not parse ${this.options.displayName} settings.json`)
      }
      const { missing, matchedForms } = findManagedEventHookForms(
        config,
        this.options.plan(options).install.map(({ eventName }) => eventName),
        (event) => [buildManagedCommandHook(getRemoteManagedEventCommand(event, scriptPath))]
      )
      let scriptMatches =
        matchedForms.length > 0 &&
        (await readTextFileRemote(sftp, scriptPath)) === this.options.script()
      if (scriptMatches) {
        const mode = await sftpOperation<{ mode: number }>(`stat ${scriptPath}`, (callback) =>
          sftp.stat(scriptPath, callback)
        )
        scriptMatches = (mode.mode & 0o111) !== 0
      }
      const state =
        matchedForms.length === 0
          ? 'not_installed'
          : missing.length || !scriptMatches
            ? 'partial'
            : 'installed'
      return {
        agent: this.options.agent,
        state,
        configPath,
        managedHooksPresent: matchedForms.length > 0,
        detail:
          state === 'partial' ? 'Managed events or hook script are missing or outdated.' : null
      }
    } catch (error) {
      return {
        agent: this.options.agent,
        state: 'error',
        configPath,
        managedHooksPresent: false,
        detail: String(error)
      }
    }
  }

  /** Explicit guest cleanup is independent of CLI presence and never creates absent settings. */
  async remove(
    sftp: SFTPWrapper,
    remoteHome: string,
    options: { configDir?: string } = {}
  ): Promise<AgentHookInstallStatus> {
    const current = options.configDir
      ? `${options.configDir.replace(/\/$/, '')}/settings.json`
      : getRemoteConfigPath(remoteHome, this.options.settings)
    const failures: string[] = []
    for (const path of new Set([current, getRemoteConfigPath(remoteHome, this.options.settings)])) {
      try {
        const text = await readTextFileRemote(sftp, path)
        if (text === null) {
          continue
        }
        const config = parseHooksJsonText(text)
        if (!config) {
          throw new Error(`Could not parse ${path}`)
        }
        const next = removeManagedHooks(
          config,
          getPosixManagedScriptFileName(this.options.settings)
        )
        if (next.changed) {
          await writeHooksJsonRemote(sftp, path, next.config)
        }
      } catch (error) {
        failures.push(String(error))
      }
    }
    const status = await this.getStatus(sftp, remoteHome, options)
    return failures.length ? { ...status, state: 'error', detail: failures.join('; ') } : status
  }
}
