import type { SFTPWrapper } from 'ssh2'
import type { AgentHookInstallStatus } from '../../shared/agent-hook-types'
import {
  buildWindowsAgentHookCurlPostCommand,
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
import { buildPosixAgentHookPostCommand } from '../agent-hooks/hook-post-command'
import {
  applyZCodeManagedHooks,
  getZCodeConfigPath,
  getZCodeManagedCommand,
  getZCodeManagedScriptFileName,
  getZCodeManagedScriptPath,
  getZCodePosixManagedScriptFileName,
  getZCodeRemoteConfigPath,
  getZCodeRemoteManagedCommand,
  isZCodeHooksEnabled,
  readManagedZCodeHookEvents,
  removeZCodeManagedHooks,
  ZCODE_HOOK_EVENTS,
  type ZCodeConfig
} from './hook-settings'
import {
  parseZCodeConfigText,
  readZCodeConfigSource,
  serializeZCodeConfig
} from './hook-config-json'

function getManagedScript(target: 'local' | 'posix' = 'local'): string {
  if (target === 'local' && process.platform === 'win32') {
    return [
      '@echo off',
      'setlocal',
      // Refresh port/token from the endpoint file so retained PTYs reach the restarted server.
      'if defined ORCA_AGENT_HOOK_ENDPOINT if exist "%ORCA_AGENT_HOOK_ENDPOINT%" call "%ORCA_AGENT_HOOK_ENDPOINT%" 2>nul',
      ...buildWindowsHookEnvironmentGuardLines(),
      buildWindowsAgentHookCurlPostCommand('zcode'),
      'exit /b 0',
      ...buildWindowsHookStdinDrainEpilogue(),
      ''
    ].join('\r\n')
  }

  return [
    '#!/bin/sh',
    ...buildPosixHookPayloadCapture(),
    ...buildPosixHookSpoolLines('zcode'),
    // Refresh retained PTY endpoints at invocation; silence source races/parse errors so hooks fail open without polluting transcripts.
    'if [ -n "$ORCA_AGENT_HOOK_ENDPOINT" ] && [ -r "$ORCA_AGENT_HOOK_ENDPOINT" ]; then',
    '  . "$ORCA_AGENT_HOOK_ENDPOINT" 2>/dev/null || :',
    'fi',
    'if [ -z "$ORCA_AGENT_HOOK_PORT" ] || [ -z "$ORCA_AGENT_HOOK_TOKEN" ] || [ -z "$ORCA_PANE_KEY" ]; then',
    '  spool_hook_event',
    '  exit 0',
    'fi',
    ...buildPosixAgentHookPostCommand('zcode').map((line, index, lines) =>
      index === lines.length - 1 ? `${line} >/dev/null 2>&1 || spool_hook_event` : line
    ),
    'exit 0',
    ''
  ].join('\n')
}

function zcodeHookError(configPath: string, detail: string): AgentHookInstallStatus {
  return { agent: 'zcode', state: 'error', configPath, managedHooksPresent: false, detail }
}

function buildStatus(
  config: ZCodeConfig,
  configPath: string,
  scriptFileName: string
): AgentHookInstallStatus {
  const base = { agent: 'zcode' as const, configPath }
  const present = readManagedZCodeHookEvents(config, scriptFileName)
  const missing = ZCODE_HOOK_EVENTS.filter((event) => !present.has(event))
  // ZCode defaults hooks off; require enabled as well as registered events.
  const hooksEnabled = isZCodeHooksEnabled(config)

  if (missing.length === 0 && hooksEnabled) {
    return { ...base, state: 'installed', managedHooksPresent: true, detail: null }
  }
  if (present.size === 0) {
    return { ...base, state: 'not_installed', managedHooksPresent: false, detail: null }
  }
  const reasons = [
    missing.length > 0 ? `events: ${missing.join(', ')}` : '',
    hooksEnabled ? '' : '`hooks.enabled` is false, so ZCode runs no hooks'
  ].filter(Boolean)
  return { ...base, state: 'partial', managedHooksPresent: true, detail: reasons.join('; ') }
}

export class ZCodeHookService {
  async refreshManagedScripts(): Promise<void> {
    await refreshManagedScriptIfPresent(getZCodeManagedScriptPath(), getManagedScript())
  }

  getStatus(): AgentHookInstallStatus {
    const configPath = getZCodeConfigPath()
    const source = readZCodeConfigSource(configPath)
    if (!source) {
      return zcodeHookError(configPath, 'Could not read ZCode config.json')
    }
    return buildStatus(source.config, configPath, getZCodeManagedScriptFileName())
  }

  install(): AgentHookInstallStatus {
    const configPath = getZCodeConfigPath()
    const scriptPath = getZCodeManagedScriptPath()
    const source = readZCodeConfigSource(configPath)
    if (!source) {
      return zcodeHookError(configPath, 'Could not read ZCode config.json')
    }

    const scriptFileName = getZCodeManagedScriptFileName()
    const command = getZCodeManagedCommand(scriptPath)
    const nextConfig = applyZCodeManagedHooks(source.config, command, scriptFileName)
    // Write script before publishing config references so no event points at a missing file.
    writeManagedScript(scriptPath, getManagedScript())
    writeHooksJson(configPath, nextConfig, {
      serialized: serializeZCodeConfig(source.text, nextConfig)
    })
    return this.getStatus()
  }

  // SSH hook installation uses the remote POSIX contract.
  async installRemote(sftp: SFTPWrapper, remoteHome: string): Promise<AgentHookInstallStatus> {
    const remoteConfigPath = getZCodeRemoteConfigPath(remoteHome)
    // Remote Windows is unsupported here; local process.platform cannot describe an SSH host.
    const remoteScriptFileName = getZCodePosixManagedScriptFileName()
    const remoteScriptPath = `${remoteHome.replace(/\/$/, '')}/.orca/agent-hooks/${remoteScriptFileName}`
    try {
      const body = await readTextFileRemote(sftp, remoteConfigPath)
      const config = body === null ? {} : parseZCodeConfigText(body, 'remote ZCode config.json')
      if (!config) {
        return zcodeHookError(remoteConfigPath, 'Could not parse remote ZCode config.json')
      }

      const command = getZCodeRemoteManagedCommand(remoteScriptPath)
      const nextConfig = applyZCodeManagedHooks(config, command, remoteScriptFileName)
      await writeManagedScriptRemote(sftp, remoteScriptPath, getManagedScript('posix'))
      await writeHooksJsonRemote(sftp, remoteConfigPath, nextConfig, {
        serialized: serializeZCodeConfig(body, nextConfig)
      })

      return {
        agent: 'zcode',
        state: 'installed',
        configPath: remoteConfigPath,
        managedHooksPresent: true,
        detail: null
      }
    } catch (err) {
      return zcodeHookError(remoteConfigPath, err instanceof Error ? err.message : String(err))
    }
  }

  remove(): AgentHookInstallStatus {
    const configPath = getZCodeConfigPath()
    const source = readZCodeConfigSource(configPath)
    if (!source) {
      return zcodeHookError(configPath, 'Could not read ZCode config.json')
    }
    const { config: nextConfig, changed } = removeZCodeManagedHooks(
      source.config,
      getZCodeManagedScriptFileName()
    )
    if (changed) {
      writeHooksJson(configPath, nextConfig, {
        serialized: serializeZCodeConfig(source.text, nextConfig)
      })
    }
    return this.getStatus()
  }
}

export const zcodeHookService = new ZCodeHookService()
