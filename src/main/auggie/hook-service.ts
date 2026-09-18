import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, posix as pathPosix } from 'node:path'
import type { SFTPWrapper } from 'ssh2'
import {
  buildPosixHookPayloadCapture,
  buildPosixHookSpoolLines,
  POSIX_HOOK_BOUNDED_JSON_STDIN,
  buildWindowsHookEnvironmentGuardLines,
  buildWindowsHookStdinDrainEpilogue
} from '../agent-hooks/hook-stdin-contract'
import {
  getSharedManagedScriptPath,
  wrapPosixHookCommand,
  wrapWindowsCmdHookCommand,
  buildWindowsAgentHookPostCommand,
  writeHooksJson,
  writeManagedScript
} from '../agent-hooks/installer-utils'
import {
  readTextFileRemote,
  writeHooksJsonRemote,
  writeManagedScriptRemote
} from '../agent-hooks/installer-utils-remote'
import {
  applyAuggieManagedHooks,
  AUGGIE_HOOK_EVENTS,
  isManagedAuggieCommand,
  readAuggieManagedEvents,
  removeAuggieManagedHooks
} from './hook-config'
import type { HooksConfig } from '../agent-hooks/installer-utils'
import { createIntegrationHealthStore } from '../agent-hooks/integration-health'
import { ORCA_HOOK_PROTOCOL_VERSION } from '../../shared/agent-hook-types'
import { getAppEnvironment } from '../../shared/app-environment'
import { refreshManagedScriptIfPresent } from '../agent-hooks/managed-hook-script-refresh'

const SCRIPT_NAME = 'aug-hook.sh'
const WINDOWS_SCRIPT_NAME = 'aug-hook.cmd'
const isManagedCommand = isManagedAuggieCommand

export type AuggieInstallState = 'installed' | 'not_installed' | 'partial' | 'error'
export type AuggieInstallStatus = {
  /** Canonical managed-hook target; provider/vendor name remains `auggie`. */
  agent: 'aug'
  state: AuggieInstallState
  configPath: string
  managedHooksPresent: boolean
  detail: string | null
}

function getAuggieHome(): string {
  return process.env.AUGMENT_HOME?.trim() || join(homedir(), '.augment')
}

function getConfigPath(): string {
  return join(getAuggieHome(), 'settings.json')
}
function getScriptPath(): string {
  return getSharedManagedScriptPath(
    process.platform === 'win32' ? WINDOWS_SCRIPT_NAME : SCRIPT_NAME
  )
}

export function buildAuggieManagedScript(target: 'local' | 'posix' = 'local'): string {
  void target
  const endpoint = [
    'if [ -n "$ORCA_AGENT_HOOK_ENDPOINT" ] && [ -r "$ORCA_AGENT_HOOK_ENDPOINT" ]; then',
    '  . "$ORCA_AGENT_HOOK_ENDPOINT" 2>/dev/null || :',
    'fi',
    'if [ -z "$ORCA_AGENT_HOOK_PORT" ] || [ -z "$ORCA_AGENT_HOOK_TOKEN" ] || [ -z "$ORCA_PANE_KEY" ]; then',
    '  spool_hook_event',
    '  exit 0',
    'fi'
  ]
  return [
    '#!/bin/sh',
    ...buildPosixHookPayloadCapture('exit', POSIX_HOOK_BOUNDED_JSON_STDIN),
    ...buildPosixHookSpoolLines('auggie'),
    ...endpoint,
    'printf \'%s\' "$payload" | curl -sS -X POST "http://127.0.0.1:${ORCA_AGENT_HOOK_PORT}/hook/aug" \\',
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

export function buildAuggieWindowsManagedScript(): string {
  return [
    '@echo off',
    'setlocal',
    'if defined ORCA_AGENT_HOOK_ENDPOINT if exist "%ORCA_AGENT_HOOK_ENDPOINT%" call "%ORCA_AGENT_HOOK_ENDPOINT%" 2>nul',
    ...buildWindowsHookEnvironmentGuardLines(),
    buildWindowsAgentHookPostCommand('auggie', [], '/hook/aug'),
    'exit /b 0',
    ...buildWindowsHookStdinDrainEpilogue(),
    ''
  ].join('\r\n')
}

function readConfig(path: string): HooksConfig | null {
  if (!existsSync(path)) {
    return {}
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return null
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: JSON object shape is validated above; hook fields are validated by installer utils.
    return parsed as HooksConfig
  } catch {
    return null
  }
}

function status(configPath: string, config: HooksConfig | null): AuggieInstallStatus {
  if (!config) {
    return {
      agent: 'aug',
      state: 'error',
      configPath,
      managedHooksPresent: false,
      detail: 'Could not parse Auggie settings.json'
    }
  }
  const present = readAuggieManagedEvents(config, isManagedCommand)
  const missing = AUGGIE_HOOK_EVENTS.filter((event) => !present.has(event))
  return {
    agent: 'aug',
    state: missing.length === 0 ? 'installed' : present.size === 0 ? 'not_installed' : 'partial',
    configPath,
    managedHooksPresent: present.size > 0,
    detail:
      missing.length === 0 || present.size === 0
        ? null
        : `Managed hook missing for events: ${missing.join(', ')}`
  }
}

export class AuggieHookService {
  async refreshManagedScripts(): Promise<void> {
    await refreshManagedScriptIfPresent(
      getScriptPath(),
      process.platform === 'win32' ? buildAuggieWindowsManagedScript() : buildAuggieManagedScript()
    )
  }

  getStatus(): AuggieInstallStatus {
    const path = getConfigPath()
    return status(path, readConfig(path))
  }
  install(): AuggieInstallStatus {
    const path = getConfigPath()
    const config = readConfig(path)
    if (!config) {
      return status(path, null)
    }
    const scriptPath = getScriptPath()
    const command =
      process.platform === 'win32'
        ? wrapWindowsCmdHookCommand(scriptPath)
        : wrapPosixHookCommand(scriptPath)
    writeManagedScript(
      scriptPath,
      process.platform === 'win32' ? buildAuggieWindowsManagedScript() : buildAuggieManagedScript()
    )
    writeHooksJson(path, applyAuggieManagedHooks(config, command))
    try {
      createIntegrationHealthStore(
        join(getAppEnvironment().getPath('userData'), 'agent-hooks', 'integration-health.json')
      ).recordArtifact({
        integration: 'auggie',
        host: 'local',
        scope: path,
        bytes:
          process.platform === 'win32'
            ? buildAuggieWindowsManagedScript()
            : buildAuggieManagedScript(),
        version: ORCA_HOOK_PROTOCOL_VERSION
      })
    } catch {
      // Why: the hook is already written. getAppEnvironment() throws by contract outside an
      // installed environment, and a diagnostics write must not report a real install as failed.
    }
    return this.getStatus()
  }
  remove(): AuggieInstallStatus {
    const path = getConfigPath()
    const config = readConfig(path)
    if (!config) {
      return status(path, null)
    }
    writeHooksJson(path, removeAuggieManagedHooks(config))
    try {
      createIntegrationHealthStore(
        join(getAppEnvironment().getPath('userData'), 'agent-hooks', 'integration-health.json')
      ).markArtifactStale('auggie', 'local', path)
    } catch {
      // Diagnostics must never gate removal.
    }
    return this.getStatus()
  }
  async installRemote(sftp: SFTPWrapper, remoteHome: string): Promise<AuggieInstallStatus> {
    const path = pathPosix.join(remoteHome, '.augment', 'settings.json')
    const script = pathPosix.join(remoteHome, '.orca', 'agent-hooks', SCRIPT_NAME)
    try {
      const raw = await readTextFileRemote(sftp, path)
      const parsed: unknown = raw ? JSON.parse(raw) : {}
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('Could not parse remote Auggie settings.json')
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: remote JSON object shape is checked before hook normalization.
      const config = parsed as HooksConfig
      await writeManagedScriptRemote(sftp, script, buildAuggieManagedScript('posix'))
      await writeHooksJsonRemote(
        sftp,
        path,
        applyAuggieManagedHooks(config, wrapPosixHookCommand(script))
      )
      return {
        agent: 'aug',
        state: 'installed',
        configPath: path,
        managedHooksPresent: true,
        detail: null
      }
    } catch (error) {
      return {
        agent: 'aug',
        state: 'error',
        configPath: path,
        managedHooksPresent: false,
        detail: error instanceof Error ? error.message : String(error)
      }
    }
  }
}

export const auggieHookService = new AuggieHookService()
