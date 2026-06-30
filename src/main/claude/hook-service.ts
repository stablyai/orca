import type { SFTPWrapper } from 'ssh2'
import type { AgentHookInstallState, AgentHookInstallStatus } from '../../shared/agent-hook-types'
import {
  buildWindowsAgentHookCurlPostCommand,
  readHooksJson,
  writeHooksJson,
  writeManagedScript
} from '../agent-hooks/installer-utils'
import {
  readHooksJsonRemote,
  writeHooksJsonRemote,
  writeManagedScriptRemote
} from '../agent-hooks/installer-utils-remote'
import {
  applyManagedHooks,
  CLAUDE_EVENTS,
  CLAUDE_HOOK_SETTINGS,
  findManagedConfigPath,
  getLegacyConfigPath,
  getLocalConfigPath,
  getManagedScriptFileName,
  getManagedCommand,
  getManagedScriptPath,
  getPosixManagedScriptFileName,
  getRemoteConfigPath,
  getRemoteManagedCommand,
  removeManagedHooks,
  type ClaudeCompatibleHookSettings
} from './hook-settings'

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

function getManagedScript(
  target: 'local' | 'posix' = 'local',
  options: { skipWhenDevinImportsClaude?: boolean } = {}
): string {
  if (target === 'local' && process.platform === 'win32') {
    return [
      '@echo off',
      'setlocal',
      ...(options.skipWhenDevinImportsClaude
        ? [
            'if not "%DEVIN_PROJECT_DIR%"=="" exit /b 0'
          ]
        : []),
      'if defined ORCA_AGENT_HOOK_ENDPOINT if exist "%ORCA_AGENT_HOOK_ENDPOINT%" call "%ORCA_AGENT_HOOK_ENDPOINT%" 2>nul',
      'if "%ORCA_AGENT_HOOK_PORT%"=="" exit /b 0',
      'if "%ORCA_AGENT_HOOK_TOKEN%"=="" exit /b 0',
      'if "%ORCA_PANE_KEY%"=="" exit /b 0',
      buildWindowsAgentHookCurlPostCommand('claude'),
      'exit /b 0',
      ''
    ].join('\r\n')
  }

  return [
    '#!/bin/sh',
    ...(options.skipWhenDevinImportsClaude
      ? [
          'if [ -n "$DEVIN_PROJECT_DIR" ]; then',
          '  exit 0',
          'fi'
        ]
      : []),
    'if [ -n "$ORCA_AGENT_HOOK_ENDPOINT" ] && [ -r "$ORCA_AGENT_HOOK_ENDPOINT" ]; then',
    '  . "$ORCA_AGENT_HOOK_ENDPOINT" 2>/dev/null || :',
    'fi',
    'if [ -z "$ORCA_AGENT_HOOK_PORT" ] || [ -z "$ORCA_AGENT_HOOK_TOKEN" ] || [ -z "$ORCA_PANE_KEY" ]; then',
    '  exit 0',
    'fi',
    'payload=$(cat)',
    'if [ -z "$payload" ]; then',
    '  exit 0',
    'fi',
    'curl -sS -X POST "http://127.0.0.1:${ORCA_AGENT_HOOK_PORT}/hook/claude" \\',
    '  --connect-timeout 0.5 --max-time 1.5 \\',
    '  -H "Content-Type: application/x-www-form-urlencoded" \\',
    '  -H "X-Orca-Agent-Hook-Token: ${ORCA_AGENT_HOOK_TOKEN}" \\',
    '  --data-urlencode "paneKey=${ORCA_PANE_KEY}" \\',
    '  --data-urlencode "tabId=${ORCA_TAB_ID}" \\',
    '  --data-urlencode "launchToken=${ORCA_AGENT_LAUNCH_TOKEN}" \\',
    '  --data-urlencode "worktreeId=${ORCA_WORKTREE_ID}" \\',
    '  --data-urlencode "env=${ORCA_AGENT_HOOK_ENV}" \\',
    '  --data-urlencode "version=${ORCA_AGENT_HOOK_VERSION}" \\',
    '  --data-urlencode "payload=${payload}" >/dev/null 2>&1 || true',
    'exit 0',
    ''
  ].join('\n')
}

export class ClaudeHookService {
  private readonly options: ClaudeHookServiceOptions

  constructor(options: ClaudeHookServiceOptions = DEFAULT_CLAUDE_HOOK_SERVICE_OPTIONS) {
    this.options = options
  }

  getStatus(): AgentHookInstallStatus {
    const scriptPath = getManagedScriptPath(this.options.settings)
    const existing = findManagedConfigPath(this.options.settings, getManagedScriptFileName(this.options.settings))

    const configPath = existing?.configPath ?? getLocalConfigPath(this.options.settings)
    const config = existing?.config

    if (!config) {
      const localConfig = readHooksJson(getLocalConfigPath(this.options.settings))
      if (localConfig === null) {
        return {
          agent: this.options.agent,
          state: 'error',
          configPath: getLocalConfigPath(this.options.settings),
          managedHooksPresent: false,
          detail: `Could not parse ${this.options.displayName} settings.local.json`
        }
      }
      return {
        agent: this.options.agent,
        state: 'not_installed',
        configPath: getLocalConfigPath(this.options.settings),
        managedHooksPresent: false
      }
    }

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
    const scriptPath = getManagedScriptPath(this.options.settings)
    const scriptFileName = getManagedScriptFileName(this.options.settings)
    const command = getManagedCommand(scriptPath)

    // Write the managed script first (shared path, not config-file-specific)
    writeManagedScript(
      scriptPath,
      getManagedScript('local', { skipWhenDevinImportsClaude: this.options.agent === 'claude' })
    )

    // Check if hooks already exist in either file
    const existing = findManagedConfigPath(this.options.settings, scriptFileName)
    if (existing) {
      // Hooks already exist — update in place (don't duplicate to the other file)
      const nextConfig = applyManagedHooks(existing.config, command, scriptFileName)
      writeHooksJson(existing.configPath, nextConfig)
    } else {
      // No hooks found — write to settings.local.json (primary, machine-specific)
      const localConfigPath = getLocalConfigPath(this.options.settings)
      const localConfig = readHooksJson(localConfigPath) ?? {}
      const nextConfig = applyManagedHooks(localConfig, command, scriptFileName)
      writeHooksJson(localConfigPath, nextConfig)
    }

    return this.getStatus()
  }

  async installRemote(sftp: SFTPWrapper, remoteHome: string): Promise<AgentHookInstallStatus> {
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
          detail: `Could not parse remote ${this.options.displayName} settings.local.json`
        }
      }

      const command = getRemoteManagedCommand(remoteScriptPath)
      const nextConfig = applyManagedHooks(config, command, remoteScriptFileName)

      await writeManagedScriptRemote(
        sftp,
        remoteScriptPath,
        getManagedScript('posix', { skipWhenDevinImportsClaude: this.options.agent === 'claude' })
      )
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
    const scriptFileName = getManagedScriptFileName(this.options.settings)

    // Remove managed hooks from BOTH files (primary and legacy) to ensure
    // complete cleanup regardless of which file hooks were installed in.

    // Remove from settings.local.json (primary)
    const localConfigPath = getLocalConfigPath(this.options.settings)
    const localConfig = readHooksJson(localConfigPath)
    if (localConfig) {
      const { config: nextConfig, changed } = removeManagedHooks(localConfig, scriptFileName)
      if (changed) {
        writeHooksJson(localConfigPath, nextConfig)
      }
    }

    // Remove from settings.json (legacy)
    const legacyConfigPath = getLegacyConfigPath(this.options.settings)
    const legacyConfig = readHooksJson(legacyConfigPath)
    if (legacyConfig) {
      const { config: nextConfig, changed } = removeManagedHooks(legacyConfig, scriptFileName)
      if (changed) {
        writeHooksJson(legacyConfigPath, nextConfig)
      }
    }

    return this.getStatus()
  }
}

export const claudeHookService = new ClaudeHookService()
