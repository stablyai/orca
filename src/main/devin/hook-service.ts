import type { SFTPWrapper } from 'ssh2'
import type { AgentHookInstallState, AgentHookInstallStatus } from '../../shared/agent-hook-types'
import {
  buildWindowsAgentHookPostCommand,
  writeHooksJson,
  writeManagedScript
} from '../agent-hooks/installer-utils'
import { refreshManagedScriptIfPresent } from '../agent-hooks/managed-hook-script-refresh'
import {
  readTextFileRemote,
  writeHooksJsonRemote,
  writeManagedScriptRemote
} from '../agent-hooks/installer-utils-remote'
import {
  buildPosixHookPayloadCapture,
  buildPosixHookSpoolLines,
  buildWindowsHookEnvironmentGuardLines,
  buildWindowsHookStdinDrainEpilogue
} from '../agent-hooks/hook-stdin-contract'
import { posixCurlCommand } from '../agent-hooks/hook-post-command'
import {
  applyDevinManagedHooks,
  DEVIN_EVENTS,
  getDevinConfigPath,
  getDevinManagedCommand,
  getDevinManagedScriptFileName,
  getDevinManagedScriptPath,
  getDevinPosixManagedScriptFileName,
  getDevinRemoteConfigPath,
  getDevinRemoteManagedCommand,
  removeDevinManagedHooks
} from './hook-settings'
import {
  mergeHookInstallDetail,
  parseDevinHooksConfigText,
  readConfigFromOrcaOverlapDetail,
  readDevinHooksConfig,
  readDevinHooksSource,
  serializeDevinHooksConfig
} from './hook-config-json'

function getManagedScript(target: 'local' | 'posix' = 'local'): string {
  if (target === 'local' && process.platform === 'win32') {
    return [
      '@echo off',
      'setlocal',
      // Refresh endpoint credentials for PTYs that outlive an Orca restart.
      'if defined ORCA_AGENT_HOOK_ENDPOINT if exist "%ORCA_AGENT_HOOK_ENDPOINT%" call "%ORCA_AGENT_HOOK_ENDPOINT%" 2>nul',
      ...buildWindowsHookEnvironmentGuardLines(),
      buildWindowsAgentHookPostCommand('devin'),
      'exit /b 0',
      ...buildWindowsHookStdinDrainEpilogue(),
      ''
    ].join('\r\n')
  }

  return [
    '#!/bin/sh',
    ...buildPosixHookPayloadCapture(),
    ...buildPosixHookSpoolLines('devin'),
    // Refresh endpoint credentials for PTYs that outlive an Orca restart.
    // Keep endpoint-file races and parse errors out of agent transcripts.
    'if [ -n "$ORCA_AGENT_HOOK_ENDPOINT" ] && [ -r "$ORCA_AGENT_HOOK_ENDPOINT" ]; then',
    '  . "$ORCA_AGENT_HOOK_ENDPOINT" 2>/dev/null || :',
    'fi',
    'if [ -z "$ORCA_AGENT_HOOK_PORT" ] || [ -z "$ORCA_AGENT_HOOK_TOKEN" ] || [ -z "$ORCA_PANE_KEY" ]; then',
    '  spool_hook_event',
    '  exit 0',
    'fi',
    // Form encoding handles filesystem paths containing quotes or newlines.
    // stdin keeps large payloads off the command line to avoid EDR false positives.
    `printf '%s' "$payload" | ${posixCurlCommand()} -sS -X POST "http://127.0.0.1:\${ORCA_AGENT_HOOK_PORT}/hook/devin" \\`,
    '  --connect-timeout 0.5 --max-time 1.5 \\',
    '  -H "Content-Type: application/x-www-form-urlencoded" \\',
    '  -H "X-Orca-Agent-Hook-Token: ${ORCA_AGENT_HOOK_TOKEN}" \\',
    '  --data-urlencode "paneKey=${ORCA_PANE_KEY}" \\',
    '  --data-urlencode "tabId=${ORCA_TAB_ID}" \\',
    '  --data-urlencode "launchToken=${ORCA_AGENT_LAUNCH_TOKEN}" \\',
    '  --data-urlencode "worktreeId=${ORCA_WORKTREE_ID}" \\',
    '  --data-urlencode "env=${ORCA_AGENT_HOOK_ENV}" \\',
    '  --data-urlencode "version=${ORCA_AGENT_HOOK_VERSION}" \\',
    '  --data-urlencode "payload@-" >/dev/null 2>&1 || spool_hook_event',
    'exit 0',
    ''
  ].join('\n')
}

export class DevinHookService {
  async refreshManagedScripts(): Promise<void> {
    await refreshManagedScriptIfPresent(getDevinManagedScriptPath(), getManagedScript())
  }

  getStatus(): AgentHookInstallStatus {
    const configPath = getDevinConfigPath()
    const scriptPath = getDevinManagedScriptPath()
    const config = readDevinHooksConfig(configPath)
    if (!config) {
      return {
        agent: 'devin',
        state: 'error',
        configPath,
        managedHooksPresent: false,
        detail: 'Could not parse Devin config.json'
      }
    }

    const command = getDevinManagedCommand(scriptPath)
    const missing: string[] = []
    let presentCount = 0
    for (const event of DEVIN_EVENTS) {
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
    return {
      agent: 'devin',
      state,
      configPath,
      managedHooksPresent,
      detail: mergeHookInstallDetail(detail, readConfigFromOrcaOverlapDetail(config))
    }
  }

  install(): AgentHookInstallStatus {
    const configPath = getDevinConfigPath()
    const scriptPath = getDevinManagedScriptPath()
    const source = readDevinHooksSource(configPath)
    if (!source) {
      return {
        agent: 'devin',
        state: 'error',
        configPath,
        managedHooksPresent: false,
        detail: 'Could not parse Devin config.json'
      }
    }

    const command = getDevinManagedCommand(scriptPath)
    const nextConfig = applyDevinManagedHooks(
      source.config,
      command,
      getDevinManagedScriptFileName()
    )
    writeManagedScript(scriptPath, getManagedScript())
    writeHooksJson(configPath, nextConfig, {
      serialized: serializeDevinHooksConfig(source.text, nextConfig)
    })
    return this.getStatus()
  }

  async installRemote(sftp: SFTPWrapper, remoteHome: string): Promise<AgentHookInstallStatus> {
    // Remote hook scripts use POSIX syntax regardless of the local platform.
    const remoteConfigPath = getDevinRemoteConfigPath(remoteHome)
    const remoteScriptFileName = getDevinPosixManagedScriptFileName()
    const remoteScriptPath = `${remoteHome.replace(/\/$/, '')}/.orca/agent-hooks/${remoteScriptFileName}`
    try {
      const body = await readTextFileRemote(sftp, remoteConfigPath)
      const config =
        body === null ? {} : parseDevinHooksConfigText(body, 'remote Devin config.json')
      if (!config) {
        return {
          agent: 'devin',
          state: 'error',
          configPath: remoteConfigPath,
          managedHooksPresent: false,
          detail: 'Could not parse remote Devin config.json'
        }
      }

      const command = getDevinRemoteManagedCommand(remoteScriptPath)
      const nextConfig = applyDevinManagedHooks(config, command, remoteScriptFileName)

      // Publish the script before its config so partial installs cannot reference a missing script.
      await writeManagedScriptRemote(sftp, remoteScriptPath, getManagedScript('posix'))
      await writeHooksJsonRemote(sftp, remoteConfigPath, nextConfig, {
        serialized: serializeDevinHooksConfig(body, nextConfig)
      })

      return {
        agent: 'devin',
        state: 'installed',
        configPath: remoteConfigPath,
        managedHooksPresent: true,
        detail: null
      }
    } catch (err) {
      return {
        agent: 'devin',
        state: 'error',
        configPath: remoteConfigPath,
        managedHooksPresent: false,
        detail: err instanceof Error ? err.message : String(err)
      }
    }
  }

  remove(): AgentHookInstallStatus {
    const configPath = getDevinConfigPath()
    const source = readDevinHooksSource(configPath)
    if (!source) {
      return {
        agent: 'devin',
        state: 'error',
        configPath,
        managedHooksPresent: false,
        detail: 'Could not parse Devin config.json'
      }
    }
    const { config: nextConfig, changed } = removeDevinManagedHooks(
      source.config,
      getDevinManagedScriptFileName()
    )
    if (changed) {
      writeHooksJson(configPath, nextConfig, {
        serialized: serializeDevinHooksConfig(source.text, nextConfig)
      })
    }
    return this.getStatus()
  }
}

export const devinHookService = new DevinHookService()
