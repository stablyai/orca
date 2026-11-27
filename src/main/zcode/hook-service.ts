import { basename } from 'node:path'
import type { SFTPWrapper } from 'ssh2'
import type { AgentHookInstallStatus } from '../../shared/agent-hook-listener/configuration/agent-hook-types'
import { errorMessage } from '../../shared/errors/error-message'
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
  getZCodeAppCliSettingsPath,
  getZCodeConfigPath,
  getZCodeManagedCommand,
  getZCodeManagedScriptFileName,
  getZCodeManagedScriptPath,
  getZCodePosixManagedScriptFileName,
  getZCodeRemoteAppCliSettingsPath,
  getZCodeRemoteConfigPath,
  getZCodeRemoteManagedCommand,
  isZCodeHooksEnabled,
  readManagedZCodeHookEvents,
  removeZCodeManagedHooks,
  ZCODE_HOOK_EVENTS,
  type ZCodeConfig
} from './hook-settings'
import {
  readZCodeConfigSource,
  serializeZCodeConfig,
  toZCodeConfigSource,
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

/** Null source means the file exists but could not be read or parsed. */
type ZCodeHookFile = { path: string; source: ZCodeConfigSource | null; readError?: string }

// zcode-app-cli creates setting.json on first launch and migrates config.json into it; a stub would pre-empt that.
function withExistingSettingsFile(config: ZCodeHookFile, settings: ZCodeHookFile): ZCodeHookFile[] {
  return settings.source?.text === null || settings.path === config.path
    ? [config]
    : [config, settings]
}

function readLocalHookFiles(): ZCodeHookFile[] {
  const read = (path: string): ZCodeHookFile => ({ path, source: readZCodeConfigSource(path) })
  return withExistingSettingsFile(read(getZCodeConfigPath()), read(getZCodeAppCliSettingsPath()))
}

function readHookFileStatus(
  { path, source }: ZCodeHookFile,
  scriptFileName: string
): AgentHookInstallStatus {
  return source
    ? buildStatus(source.config, path, scriptFileName)
    : zcodeHookError(path, `Could not read ZCode ${basename(path)}`)
}

// Upstream ZCode and zcode-app-cli each read only their own file, so both must carry the hooks.
function combineHookFilePair(
  config: AgentHookInstallStatus,
  settings: AgentHookInstallStatus
): AgentHookInstallStatus {
  // Either file carrying hooks must keep uninstall cleanup in play, even if the other is broken.
  const managedHooksPresent = config.managedHooksPresent || settings.managedHooksPresent
  if (config.state === 'error' || config.state === settings.state) {
    return { ...config, managedHooksPresent }
  }
  if (settings.state === 'error') {
    return { ...settings, managedHooksPresent }
  }
  const incomplete =
    config.state === 'partial' || settings.state === 'installed' ? config : settings
  return {
    ...incomplete,
    state: 'partial',
    managedHooksPresent: true,
    detail: incomplete.detail ?? 'Orca hooks are missing from this file'
  }
}

// Lists every file Orca edits so status and the uninstall plan disclose setting.json too.
function combineHookFileStatuses(statuses: AgentHookInstallStatus[]): AgentHookInstallStatus {
  const combined = statuses.reduce(combineHookFilePair)
  const additionalConfigPaths = statuses
    .map((status) => status.configPath)
    .filter((path) => path !== combined.configPath)
  return additionalConfigPaths.length > 0 ? { ...combined, additionalConfigPaths } : combined
}

export class ZCodeHookService {
  async refreshManagedScripts(): Promise<void> {
    await refreshManagedScriptIfPresent(getZCodeManagedScriptPath(), getManagedScript())
  }

  getStatus(): AgentHookInstallStatus {
    const scriptFileName = getZCodeManagedScriptFileName()
    return combineHookFileStatuses(
      readLocalHookFiles().map((file) => readHookFileStatus(file, scriptFileName))
    )
  }

  install(): AgentHookInstallStatus {
    const scriptPath = getZCodeManagedScriptPath()
    const scriptFileName = getZCodeManagedScriptFileName()
    const command = getZCodeManagedCommand(scriptPath)
    const files = readLocalHookFiles()
    // Write script before publishing config references so no event points at a missing file.
    if (files.some((file) => file.source)) {
      writeManagedScript(scriptPath, getManagedScript())
    }
    for (const { path, source } of files) {
      if (!source) {
        continue
      }
      const nextConfig = applyZCodeManagedHooks(source.config, command, scriptFileName)
      writeHooksJson(path, nextConfig, {
        serialized: serializeZCodeConfig(source.text, nextConfig)
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
    // Per-file so an unreadable setting.json still lets config.json install, matching local install().
    const readRemote = async (path: string): Promise<ZCodeHookFile> => {
      try {
        const text = await readTextFileRemote(sftp, path)
        return { path, source: toZCodeConfigSource(text, `remote ZCode ${basename(path)}`) }
      } catch (err) {
        return { path, source: null, readError: errorMessage(err) }
      }
    }
    try {
      const [config, settings] = await Promise.all([
        readRemote(remoteConfigPath),
        readRemote(getZCodeRemoteAppCliSettingsPath(remoteHome))
      ])
      const files = withExistingSettingsFile(config, settings)
      const command = getZCodeRemoteManagedCommand(remoteScriptPath)
      if (files.some((file) => file.source)) {
        await writeManagedScriptRemote(sftp, remoteScriptPath, getManagedScript('posix'))
      }
      const statuses: AgentHookInstallStatus[] = []
      for (const { path, source, readError } of files) {
        if (!source) {
          statuses.push(
            zcodeHookError(path, readError ?? `Could not parse remote ZCode ${basename(path)}`)
          )
          continue
        }
        const nextConfig = applyZCodeManagedHooks(source.config, command, remoteScriptFileName)
        await writeHooksJsonRemote(sftp, path, nextConfig, {
          serialized: serializeZCodeConfig(source.text, nextConfig)
        })
        statuses.push(buildStatus(nextConfig, path, remoteScriptFileName))
      }
      return combineHookFileStatuses(statuses)
    } catch (err) {
      return zcodeHookError(remoteConfigPath, errorMessage(err))
    }
  }

  remove(): AgentHookInstallStatus {
    const scriptFileName = getZCodeManagedScriptFileName()
    for (const { path, source } of readLocalHookFiles()) {
      if (!source) {
        continue
      }
      const { config: nextConfig, changed } = removeZCodeManagedHooks(source.config, scriptFileName)
      if (changed) {
        writeHooksJson(path, nextConfig, {
          serialized: serializeZCodeConfig(source.text, nextConfig)
        })
      }
    }
    return this.getStatus()
  }
}

export const zcodeHookService = new ZCodeHookService()
