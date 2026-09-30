import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import type { SFTPWrapper } from 'ssh2'

// Muse runs managed hooks with an explicit environment allowlist. The installer
// persists Orca's hook coordinates in that allowlist so events stay attributed.
import type { AgentHookInstallState, AgentHookInstallStatus } from '../../shared/agent-hook-types'
import {
  buildWindowsAgentHookCurlPostCommand,
  writeHooksJson,
  writeManagedScript
} from '../agent-hooks/installer-utils'
import { refreshManagedScriptIfPresent } from '../agent-hooks/managed-hook-script-refresh'
import {
  readTextFileRemote,
  writeManagedScriptRemote,
  writeTextFileRemoteAtomic
} from '../agent-hooks/installer-utils-remote'
import {
  buildPosixHookPayloadCapture,
  buildPosixHookSpoolLines,
  buildWindowsHookEnvironmentGuardLines,
  buildWindowsHookStdinDrainEpilogue
} from '../agent-hooks/hook-stdin-contract'
import { buildPosixAgentHookPostCommand } from '../agent-hooks/hook-post-command'
import {
  buildMuseManagedHooksFile,
  getMuseConfigPath,
  getMuseManagedCommand,
  getMuseManagedCommandMatcher,
  getMuseManagedHooksPath,
  getMuseManagedScriptPath,
  getMuseRemoteConfigPath,
  getMuseRemoteManagedCommand,
  getMuseRemoteManagedHooksPath,
  MUSE_HOOK_EVENTS,
  readManagedMuseHookEvents
} from './hook-settings'
import {
  MUSE_MANAGED_HOOK_ENV_VARS,
  parseMuseSettingsText,
  readMuseSettingsSource,
  serializeMuseSettings
} from './hook-config-json'

function getManagedScript(target: 'local' | 'posix' = 'local'): string {
  if (target === 'local' && process.platform === 'win32') {
    return [
      '@echo off',
      'setlocal',
      'if defined ORCA_AGENT_HOOK_ENDPOINT if exist "%ORCA_AGENT_HOOK_ENDPOINT%" call "%ORCA_AGENT_HOOK_ENDPOINT%" 2>nul',
      ...buildWindowsHookEnvironmentGuardLines(),
      buildWindowsAgentHookCurlPostCommand('muse'),
      'exit /b 0',
      ...buildWindowsHookStdinDrainEpilogue(),
      ''
    ].join('\r\n')
  }

  return [
    '#!/bin/sh',
    ...buildPosixHookPayloadCapture(),
    ...buildPosixHookSpoolLines('muse'),
    // Why: endpoint file holds the live port/token; PTYs that outlive an Orca restart carry stale env, so source it to reach the new server (else PTY env).
    // Why: silence the `.` builtin (2>/dev/null + `|| :`) so a TOCTOU race can't leak shell parse errors into agent transcripts (fail-open).
    'if [ -n "$ORCA_AGENT_HOOK_ENDPOINT" ] && [ -r "$ORCA_AGENT_HOOK_ENDPOINT" ]; then',
    '  . "$ORCA_AGENT_HOOK_ENDPOINT" 2>/dev/null || :',
    'fi',
    'if [ -z "$ORCA_AGENT_HOOK_PORT" ] || [ -z "$ORCA_AGENT_HOOK_TOKEN" ] || [ -z "$ORCA_PANE_KEY" ]; then',
    '  spool_hook_event',
    '  exit 0',
    'fi',
    // Why: redirect on `fi` covers the whole if-statement (both transport branches); `|| spool` keeps the fail-open spool fallback.
    ...buildPosixAgentHookPostCommand('muse').map((line, index, lines) =>
      index === lines.length - 1 ? `${line} >/dev/null 2>&1 || spool_hook_event` : line
    ),
    'exit 0',
    ''
  ].join('\n')
}

function readManagedHooksFile(managedHooksPath: string): string | null {
  if (!existsSync(managedHooksPath)) {
    return ''
  }
  try {
    return readFileSync(managedHooksPath, 'utf-8')
  } catch {
    return null
  }
}

function buildStatus(
  config: Record<string, unknown>,
  pointer: string | undefined,
  managedHooksPath: string,
  managedText: string | null,
  configPath: string
): AgentHookInstallStatus {
  const base = { agent: 'muse' as const, configPath }
  if (managedText === null) {
    return {
      ...base,
      state: 'error',
      managedHooksPresent: false,
      detail: 'Could not read Orca managed hooks file'
    }
  }
  if (pointer !== managedHooksPath) {
    return {
      ...base,
      state: 'not_installed',
      managedHooksPresent: false,
      detail:
        pointer === undefined
          ? null
          : `managed_hooks_path points at ${pointer}, not the Orca managed hooks file`
    }
  }
  const parsed = parseMuseSettingsText(managedText, 'Orca managed Muse hooks')
  const present = readManagedMuseHookEvents(parsed, getMuseManagedCommandMatcher())
  const missing = MUSE_HOOK_EVENTS.filter((event) => !present.has(event))
  const configuredEnv = Array.isArray(config.managed_hooks_env_vars)
    ? config.managed_hooks_env_vars.filter((value): value is string => typeof value === 'string')
    : []
  const missingEnv = MUSE_MANAGED_HOOK_ENV_VARS.filter((name) => !configuredEnv.includes(name))
  let state: AgentHookInstallState
  let detail: string | null
  if (missing.length === 0 && missingEnv.length === 0) {
    state = 'installed'
    detail = null
  } else if (present.size === 0) {
    state = 'not_installed'
    detail = null
  } else {
    state = 'partial'
    detail = [
      missing.length > 0 ? `events: ${missing.join(', ')}` : null,
      missingEnv.length > 0 ? `environment variables: ${missingEnv.join(', ')}` : null
    ]
      .filter(Boolean)
      .join('; ')
  }
  return { ...base, state, managedHooksPresent: present.size > 0, detail }
}

export class MuseHookService {
  async refreshManagedScripts(): Promise<void> {
    await refreshManagedScriptIfPresent(getMuseManagedScriptPath(), getManagedScript())
  }

  getStatus(): AgentHookInstallStatus {
    const configPath = getMuseConfigPath()
    const managedHooksPath = getMuseManagedHooksPath()
    const source = readMuseSettingsSource(configPath)
    if (!source) {
      return {
        agent: 'muse',
        state: 'error',
        configPath,
        managedHooksPresent: false,
        detail: 'Could not read Muse settings.json'
      }
    }
    const pointer =
      typeof source.config.managed_hooks_path === 'string'
        ? source.config.managed_hooks_path
        : undefined
    return buildStatus(
      source.config,
      pointer,
      managedHooksPath,
      readManagedHooksFile(managedHooksPath),
      configPath
    )
  }

  install(): AgentHookInstallStatus {
    const configPath = getMuseConfigPath()
    const managedHooksPath = getMuseManagedHooksPath()
    const source = readMuseSettingsSource(configPath)
    if (!source) {
      return {
        agent: 'muse',
        state: 'error',
        configPath,
        managedHooksPresent: false,
        detail: 'Could not read Muse settings.json'
      }
    }
    const existingPointer =
      typeof source.config.managed_hooks_path === 'string'
        ? source.config.managed_hooks_path
        : undefined
    if (existingPointer !== undefined && existingPointer !== managedHooksPath) {
      return {
        agent: 'muse',
        state: 'not_installed',
        configPath,
        managedHooksPresent: false,
        detail: `managed_hooks_path points at ${existingPointer}; leaving the user's managed hooks untouched`
      }
    }
    const scriptPath = getMuseManagedScriptPath()
    const command = getMuseManagedCommand(scriptPath)
    // Write the script and managed hooks file first so settings.json never points at missing files.
    writeManagedScript(scriptPath, getManagedScript())
    writeHooksJson(
      managedHooksPath,
      { hooks: {} },
      {
        serialized: buildMuseManagedHooksFile(command)
      }
    )
    const nextText = serializeMuseSettings(source.text, managedHooksPath)
    if (source.text !== nextText) {
      writeHooksJson(configPath, source.config, { serialized: nextText })
    }
    return this.getStatus()
  }

  // Install the Muse hook on an SSH execution host, where the shell contract is POSIX.
  async installRemote(sftp: SFTPWrapper, remoteHome: string): Promise<AgentHookInstallStatus> {
    const remoteConfigPath = getMuseRemoteConfigPath(remoteHome)
    const remoteScriptPath = `${remoteHome.replace(/\/$/, '')}/.orca/agent-hooks/muse-hook.sh`
    const remoteManagedHooksPath = getMuseRemoteManagedHooksPath(remoteHome)
    try {
      const body = await readTextFileRemote(sftp, remoteConfigPath)
      const config = body === null ? {} : parseMuseSettingsText(body, 'remote Muse settings.json')
      if (!config) {
        return {
          agent: 'muse',
          state: 'error',
          configPath: remoteConfigPath,
          managedHooksPresent: false,
          detail: 'Could not parse remote Muse settings.json'
        }
      }
      const existingPointer =
        typeof config.managed_hooks_path === 'string' ? config.managed_hooks_path : undefined
      if (existingPointer !== undefined && existingPointer !== remoteManagedHooksPath) {
        return {
          agent: 'muse',
          state: 'not_installed',
          configPath: remoteConfigPath,
          managedHooksPresent: false,
          detail: `managed_hooks_path points at ${existingPointer}; leaving the user's managed hooks untouched`
        }
      }
      const command = getMuseRemoteManagedCommand(remoteScriptPath)
      // Write the script and managed hooks file first so settings.json never points at missing files.
      await writeManagedScriptRemote(sftp, remoteScriptPath, getManagedScript('posix'))
      await writeTextFileRemoteAtomic(
        sftp,
        remoteManagedHooksPath,
        buildMuseManagedHooksFile(command)
      )
      await writeTextFileRemoteAtomic(
        sftp,
        remoteConfigPath,
        serializeMuseSettings(body, remoteManagedHooksPath)
      )
      return {
        agent: 'muse',
        state: 'installed',
        configPath: remoteConfigPath,
        managedHooksPresent: true,
        detail: null
      }
    } catch (err) {
      return {
        agent: 'muse',
        state: 'error',
        configPath: remoteConfigPath,
        managedHooksPresent: false,
        detail: err instanceof Error ? err.message : String(err)
      }
    }
  }

  remove(): AgentHookInstallStatus {
    const configPath = getMuseConfigPath()
    const managedHooksPath = getMuseManagedHooksPath()
    const source = readMuseSettingsSource(configPath)
    if (!source) {
      return {
        agent: 'muse',
        state: 'error',
        configPath,
        managedHooksPresent: false,
        detail: 'Could not read Muse settings.json'
      }
    }
    if (source.config.managed_hooks_path === managedHooksPath) {
      const nextText = serializeMuseSettings(source.text, undefined)
      if (source.text !== nextText) {
        writeHooksJson(configPath, source.config, { serialized: nextText })
      }
    }
    try {
      if (existsSync(managedHooksPath)) {
        unlinkSync(managedHooksPath)
      }
    } catch {
      // best effort
    }
    return this.getStatus()
  }
}

export const museHookService = new MuseHookService()
