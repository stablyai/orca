import { unlinkSync } from 'node:fs'
import type { SFTPWrapper } from 'ssh2'
import type { AgentHookInstallStatus } from '../../shared/agent-hook-types'
import {
  buildWindowsAgentHookCurlPostCommand,
  readHooksJsonWithRaw,
  writeHooksJson,
  writeManagedScript
} from '../agent-hooks/installer-utils'
import { parseHooksJsonText } from '../agent-hooks/hooks-json-read'
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
  buildKiroHooksFile,
  getKiroHooksFilePath,
  getKiroManagedCommand,
  getKiroManagedScriptPath,
  getKiroPosixManagedScriptFileName,
  getKiroRemoteHooksFilePath,
  getKiroRemoteManagedCommand,
  isOrcaOwnedKiroHooksFile,
  KIRO_HOOK_EVENTS,
  readManagedKiroHookEvents,
  removeManagedKiroHooks
} from './hook-settings'

const FOREIGN_HOOKS_FILE_DETAIL = 'A Kiro hooks file Orca does not own already uses this name'

function getManagedScript(target: 'local' | 'posix' = 'local'): string {
  if (target === 'local' && process.platform === 'win32') {
    return [
      '@echo off',
      'setlocal',
      // Why: endpoint file holds the live port/token; a PTY that outlives an Orca restart carries stale env, so `call` it to refresh (else PTY env).
      'if defined ORCA_AGENT_HOOK_ENDPOINT if exist "%ORCA_AGENT_HOOK_ENDPOINT%" call "%ORCA_AGENT_HOOK_ENDPOINT%" 2>nul',
      ...buildWindowsHookEnvironmentGuardLines(),
      buildWindowsAgentHookCurlPostCommand('kiro'),
      'exit /b 0',
      ...buildWindowsHookStdinDrainEpilogue(),
      ''
    ].join('\r\n')
  }

  return [
    '#!/bin/sh',
    ...buildPosixHookPayloadCapture(),
    ...buildPosixHookSpoolLines('kiro'),
    // Why: endpoint file holds the live port/token; PTYs that outlive an Orca restart carry stale env, so source it to reach the new server (else PTY env).
    // Why: silence the `.` builtin (2>/dev/null + `|| :`) so a TOCTOU race can't leak shell parse errors into agent transcripts (fail-open).
    'if [ -n "$ORCA_AGENT_HOOK_ENDPOINT" ] && [ -r "$ORCA_AGENT_HOOK_ENDPOINT" ]; then',
    '  . "$ORCA_AGENT_HOOK_ENDPOINT" 2>/dev/null || :',
    'fi',
    'if [ -z "$ORCA_AGENT_HOOK_PORT" ] || [ -z "$ORCA_AGENT_HOOK_TOKEN" ] || [ -z "$ORCA_PANE_KEY" ]; then',
    '  spool_hook_event',
    '  exit 0',
    'fi',
    ...buildPosixAgentHookPostCommand('kiro').map((line, index, lines) =>
      index === lines.length - 1 ? `${line} >/dev/null 2>&1 || spool_hook_event` : line
    ),
    'exit 0',
    ''
  ].join('\n')
}

function kiroHookError(configPath: string, detail: string): AgentHookInstallStatus {
  return { agent: 'kiro', state: 'error', configPath, managedHooksPresent: false, detail }
}

export class KiroHookService {
  async refreshManagedScripts(): Promise<void> {
    await refreshManagedScriptIfPresent(getKiroManagedScriptPath(), getManagedScript())
  }

  getStatus(): AgentHookInstallStatus {
    const configPath = getKiroHooksFilePath()
    const { config } = readHooksJsonWithRaw(configPath)
    if (!config) {
      return kiroHookError(configPath, 'Could not read the Orca Kiro hooks file')
    }
    const base = { agent: 'kiro' as const, configPath }
    // Why active only: Kiro skips disabled entries and files that are not v1, so those never fire.
    const active = readManagedKiroHookEvents(config, { activeOnly: true })
    const missing = KIRO_HOOK_EVENTS.filter((event) => !active.has(event))
    if (missing.length === 0) {
      return { ...base, state: 'installed', managedHooksPresent: true, detail: null }
    }
    if (readManagedKiroHookEvents(config).size === 0) {
      return { ...base, state: 'not_installed', managedHooksPresent: false, detail: null }
    }
    return {
      ...base,
      state: 'partial',
      managedHooksPresent: true,
      detail: `events: ${missing.join(', ')}`
    }
  }

  install(): AgentHookInstallStatus {
    const configPath = getKiroHooksFilePath()
    const { config } = readHooksJsonWithRaw(configPath)
    if (!config) {
      return kiroHookError(configPath, 'Could not read the Orca Kiro hooks file')
    }
    // Why: the name is Orca's, but a file someone else wrote there keeps its hooks.
    if (!isOrcaOwnedKiroHooksFile(config)) {
      return kiroHookError(configPath, FOREIGN_HOOKS_FILE_DETAIL)
    }
    const scriptPath = getKiroManagedScriptPath()
    // Why: write the script first so the hooks file never points at a missing file.
    writeManagedScript(scriptPath, getManagedScript())
    // Why no merge: every entry is Orca's (checked above), so install rewrites the file whole.
    writeHooksJson(configPath, buildKiroHooksFile(getKiroManagedCommand(scriptPath)))
    return this.getStatus()
  }

  // Install the Kiro hook on an SSH execution host, where the shell contract is POSIX.
  async installRemote(sftp: SFTPWrapper, remoteHome: string): Promise<AgentHookInstallStatus> {
    const remoteConfigPath = getKiroRemoteHooksFilePath(remoteHome)
    // Why: remote-Windows is out of scope; process.platform describes the local box, not the host.
    const remoteScriptPath = `${remoteHome.replace(/\/$/, '')}/.orca/agent-hooks/${getKiroPosixManagedScriptFileName()}`
    try {
      const body = await readTextFileRemote(sftp, remoteConfigPath)
      const existing = body === null ? {} : parseHooksJsonText(body)
      if (!existing) {
        return kiroHookError(remoteConfigPath, 'Could not parse the remote Orca Kiro hooks file')
      }
      if (!isOrcaOwnedKiroHooksFile(existing)) {
        return kiroHookError(remoteConfigPath, FOREIGN_HOOKS_FILE_DETAIL)
      }
      await writeManagedScriptRemote(sftp, remoteScriptPath, getManagedScript('posix'))
      await writeHooksJsonRemote(
        sftp,
        remoteConfigPath,
        buildKiroHooksFile(getKiroRemoteManagedCommand(remoteScriptPath))
      )
      return {
        agent: 'kiro',
        state: 'installed',
        configPath: remoteConfigPath,
        managedHooksPresent: true,
        detail: null
      }
    } catch (err) {
      return kiroHookError(remoteConfigPath, err instanceof Error ? err.message : String(err))
    }
  }

  remove(): AgentHookInstallStatus {
    const configPath = getKiroHooksFilePath()
    const { config } = readHooksJsonWithRaw(configPath)
    if (!config || readManagedKiroHookEvents(config).size === 0) {
      return this.getStatus()
    }
    // Why: delete the file only when every hook in it is Orca's; hooks someone else added stay.
    if (isOrcaOwnedKiroHooksFile(config)) {
      unlinkSync(configPath)
    } else {
      writeHooksJson(configPath, removeManagedKiroHooks(config))
    }
    return this.getStatus()
  }
}

export const kiroHookService = new KiroHookService()
