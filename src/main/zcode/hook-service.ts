import { basename } from 'node:path'
import type { SFTPWrapper } from 'ssh2'
import type {
  AgentHookInstallState,
  AgentHookInstallStatus
} from '../../shared/agent-hook-listener/configuration/agent-hook-types'
import { buildWindowsAgentHookCurlPostCommand } from '../agent-hooks/installation/commands/windows-agent-hook-post-command'
import { writeHooksJson } from '../agent-hooks/installation/configuration/hooks-json-write'
import { writeManagedScript } from '../agent-hooks/installation/scripts/managed-hook-script-write'
import { refreshManagedScriptIfPresent } from '../agent-hooks/installation/scripts/managed-hook-script-refresh'
import { readTextFileRemote } from '../agent-hooks/installation/remote/hook-text-files-remote'
import { writeHooksJsonRemote } from '../agent-hooks/installation/configuration/hooks-json-remote'
import { writeManagedScriptRemote } from '../agent-hooks/installation/scripts/managed-script-write-remote'
import {
  buildPosixHookPayloadCapture,
  buildPosixHookSpoolLines,
  buildWindowsHookEnvironmentGuardLines
} from '../agent-hooks/installation/scripts/hook-stdin-contract'
import { buildPosixAgentHookPostCommand } from '../agent-hooks/installation/scripts/hook-post-command'
import {
  applyZCodeManagedHooks,
  getZCodeManagedCommand,
  getZCodeManagedScriptFileName,
  getZCodeManagedScriptPath,
  getZCodePosixManagedScriptFileName,
  getZCodeRemoteConfigPath,
  getZCodeRemoteManagedCommand,
  getZCodeRemoteNpmSettingsPath,
  getZCodeSettingsFiles,
  isZCodeHooksEnabled,
  readManagedZCodeHookEvents,
  removeZCodeManagedHooks,
  ZCODE_HOOK_EVENTS,
  type ZCodeConfig
} from './hook-settings'
import {
  parseZCodeConfigText,
  readZCodeConfigSource,
  serializeZCodeConfig,
  type ZCodeConfigSource
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

function statusOfSettings(
  source: ZCodeConfigSource | null,
  configPath: string,
  scriptFileName: string
): AgentHookInstallStatus {
  return source
    ? buildStatus(source.config, configPath, scriptFileName)
    : zcodeHookError(configPath, `Could not read ZCode ${basename(configPath)}`)
}

const ZCODE_HOOK_STATUS_SEVERITY: Record<AgentHookInstallState, number> = {
  error: 3,
  not_installed: 2,
  partial: 1,
  installed: 0,
  skipped: 0
}

/** Each ZCode build reads its own file; report the one still needing repair, most severe first. */
function combineZCodeHookStatuses(
  official: AgentHookInstallStatus,
  npm: AgentHookInstallStatus
): AgentHookInstallStatus {
  const worst = [official, npm].toSorted(
    (a, b) => ZCODE_HOOK_STATUS_SEVERITY[b.state] - ZCODE_HOOK_STATUS_SEVERITY[a.state]
  )[0]
  return worst.state === 'installed'
    ? official
    : { ...worst, managedHooksPresent: official.managedHooksPresent || npm.managedHooksPresent }
}

export class ZCodeHookService {
  async refreshManagedScripts(): Promise<void> {
    await refreshManagedScriptIfPresent(getZCodeManagedScriptPath(), getManagedScript())
  }

  getStatus(): AgentHookInstallStatus {
    const scriptFileName = getZCodeManagedScriptFileName()
    const [config, npmSettings] = getZCodeSettingsFiles()
    const sources = [config, npmSettings].map(({ path }) => readZCodeConfigSource(path))
    const official = statusOfSettings(sources[0], config.path, scriptFileName)
    const npmSource = sources[1]
    const npm =
      npmSource?.text === null && !npmSettings.createIfMissing
        ? null
        : statusOfSettings(npmSource, npmSettings.path, scriptFileName)
    return npm ? combineZCodeHookStatuses(official, npm) : official
  }

  install(): AgentHookInstallStatus {
    const scriptFileName = getZCodeManagedScriptFileName()
    const command = getZCodeManagedCommand(getZCodeManagedScriptPath())
    for (const { path, createIfMissing } of getZCodeSettingsFiles()) {
      const source = readZCodeConfigSource(path)
      if (!source) {
        return zcodeHookError(path, `Could not read ZCode ${basename(path)}`)
      }
      if (source.text === null && !createIfMissing) {
        continue
      }
      const nextConfig = applyZCodeManagedHooks(source.config, command, scriptFileName)
      // Write script before publishing config references so no event points at a missing file.
      writeManagedScript(getZCodeManagedScriptPath(), getManagedScript())
      writeHooksJson(path, nextConfig, {
        serialized: serializeZCodeConfig(source.text, nextConfig, path)
      })
    }
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
        serialized: serializeZCodeConfig(body, nextConfig, remoteConfigPath)
      })

      const npmSettingsPath = getZCodeRemoteNpmSettingsPath(remoteHome)
      const npmSettingsBody = await readTextFileRemote(sftp, npmSettingsPath)
      if (npmSettingsBody !== null) {
        const npmSettings = parseZCodeConfigText(npmSettingsBody, 'remote ZCode setting.json')
        if (!npmSettings) {
          return zcodeHookError(npmSettingsPath, 'Could not parse remote ZCode setting.json')
        }
        const npmNextConfig = applyZCodeManagedHooks(npmSettings, command, remoteScriptFileName)
        await writeHooksJsonRemote(sftp, npmSettingsPath, npmNextConfig, {
          serialized: serializeZCodeConfig(npmSettingsBody, npmNextConfig, npmSettingsPath)
        })
      }

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
    const scriptFileName = getZCodeManagedScriptFileName()
    for (const { path } of getZCodeSettingsFiles()) {
      const source = readZCodeConfigSource(path)
      if (!source) {
        return zcodeHookError(path, `Could not read ZCode ${basename(path)}`)
      }
      if (source.text === null) {
        continue
      }
      const { config: nextConfig, changed } = removeZCodeManagedHooks(source.config, scriptFileName)
      if (changed) {
        writeHooksJson(path, nextConfig, {
          serialized: serializeZCodeConfig(source.text, nextConfig, path)
        })
      }
    }
    return this.getStatus()
  }
}

export const zcodeHookService = new ZCodeHookService()
