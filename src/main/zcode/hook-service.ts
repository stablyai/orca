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
      // Why: endpoint file holds the live port/token; a PTY that outlives an Orca restart carries stale env, so `call` it to refresh (else PTY env).
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
    // Why: endpoint file holds the live port/token; PTYs that outlive an Orca restart carry stale env, so source it to reach the new server (else PTY env).
    // Why: silence the `.` builtin (2>/dev/null + `|| :`) so a TOCTOU race can't leak shell parse errors into agent transcripts (fail-open).
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
  // Why: ZCode ships `hooks.enabled: false` by default, so registered events alone prove
  // nothing — an install that left the flag off would never deliver a single event.
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
    // Why: write the script first so config.json never points at a missing file.
    writeManagedScript(scriptPath, getManagedScript())
    writeHooksJson(configPath, nextConfig, {
      serialized: serializeZCodeConfig(source.text, nextConfig)
    })
    return this.getStatus()
  }

  // Install the ZCode hook on an SSH execution host, where the shell contract is POSIX.
  async installRemote(sftp: SFTPWrapper, remoteHome: string): Promise<AgentHookInstallStatus> {
    const remoteConfigPath = getZCodeRemoteConfigPath(remoteHome)
    // Why: remote-Windows is out of scope; process.platform describes the local box, not the host.
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
