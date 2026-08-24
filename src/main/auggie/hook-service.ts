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
import { refreshManagedScriptIfPresent } from '../agent-hooks/managed-hook-script-refresh'
import {
  buildPosixHookPayloadCapture,
  buildWindowsHookEnvironmentGuardLines,
  buildWindowsHookStdinDrainEpilogue
} from '../agent-hooks/hook-stdin-contract'
import {
  applyManagedHooks,
  AUGGIE_EVENTS,
  getConfigPath,
  getManagedHook,
  getManagedScriptFileName,
  getManagedScriptPath,
  getPosixManagedScriptFileName,
  getRemoteConfigPath,
  hasManagedHookForEvent,
  removeManagedHooks
} from './hook-settings'

// Why: Auggie treats stdout as control JSON (permissionDecision/hookSpecificOutput); unlike
// Claude's PreToolUse hooks, Orca's is observe-only, so the script must print nothing.
function getManagedScript(target: 'local' | 'posix' = 'local'): string {
  if (target === 'local' && process.platform === 'win32') {
    return [
      '@echo off',
      'setlocal',
      'if defined ORCA_AGENT_HOOK_ENDPOINT if exist "%ORCA_AGENT_HOOK_ENDPOINT%" call "%ORCA_AGENT_HOOK_ENDPOINT%" 2>nul',
      ...buildWindowsHookEnvironmentGuardLines(),
      buildWindowsAgentHookCurlPostCommand('aug'),
      'exit /b 0',
      ...buildWindowsHookStdinDrainEpilogue(),
      ''
    ].join('\r\n')
  }

  return [
    '#!/bin/sh',
    ...buildPosixHookPayloadCapture(),
    'if [ -n "$ORCA_AGENT_HOOK_ENDPOINT" ] && [ -r "$ORCA_AGENT_HOOK_ENDPOINT" ]; then',
    '  . "$ORCA_AGENT_HOOK_ENDPOINT" 2>/dev/null || :',
    'fi',
    'if [ -z "$ORCA_AGENT_HOOK_PORT" ] || [ -z "$ORCA_AGENT_HOOK_TOKEN" ] || [ -z "$ORCA_PANE_KEY" ]; then',
    '  exit 0',
    'fi',
    // Why: post form fields because path-bearing payloads are unsafe in hand-built JSON.
    // Why: pipe payload to curl stdin (`payload@-`) to keep large tool output off the command line.
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
    '  --data-urlencode "payload@-" >/dev/null 2>&1 || true',
    'exit 0',
    ''
  ].join('\n')
}

const PARSE_ERROR_DETAIL = 'Could not parse Auggie settings.json'

function errorStatus(configPath: string, detail: string): AgentHookInstallStatus {
  return { agent: 'aug', state: 'error', configPath, managedHooksPresent: false, detail }
}

function buildStatus(
  configPath: string,
  config: ReturnType<typeof readHooksJson>
): AgentHookInstallStatus {
  if (!config) {
    return errorStatus(configPath, PARSE_ERROR_DETAIL)
  }
  const missing = AUGGIE_EVENTS.filter((event) => !hasManagedHookForEvent(config, event.eventName))
  let state: AgentHookInstallState
  let detail: string | null
  const presentCount = AUGGIE_EVENTS.length - missing.length
  if (missing.length === 0) {
    state = 'installed'
    detail = null
  } else if (presentCount === 0) {
    state = 'not_installed'
    detail = null
  } else {
    state = 'partial'
    detail = `Managed hook missing for events: ${missing.map((event) => event.eventName).join(', ')}`
  }
  return { agent: 'aug', state, configPath, managedHooksPresent: presentCount > 0, detail }
}

export class AuggieHookService {
  async refreshManagedScripts(): Promise<void> {
    await refreshManagedScriptIfPresent(getManagedScriptPath(), getManagedScript())
  }

  getStatus(): AgentHookInstallStatus {
    const configPath = getConfigPath()
    return buildStatus(configPath, readHooksJson(configPath))
  }

  install(): AgentHookInstallStatus {
    const configPath = getConfigPath()
    const config = readHooksJson(configPath)
    if (!config) {
      return errorStatus(configPath, PARSE_ERROR_DETAIL)
    }
    const scriptPath = getManagedScriptPath()
    // Write the script first so settings.json never points at a missing script.
    writeManagedScript(scriptPath, getManagedScript())
    const hook = getManagedHook(scriptPath)
    writeHooksJson(configPath, applyManagedHooks(config, hook, getManagedScriptFileName()))
    return this.getStatus()
  }

  // Why: POSIX-only (mirrors Kimi/Claude remote installers) — Windows-remote is deferred.
  async installRemote(sftp: SFTPWrapper, remoteHome: string): Promise<AgentHookInstallStatus> {
    const remoteConfigPath = getRemoteConfigPath(remoteHome)
    const remoteScriptFileName = getPosixManagedScriptFileName()
    const remoteScriptPath = `${remoteHome.replace(/\/$/, '')}/.orca/agent-hooks/${remoteScriptFileName}`
    try {
      const config = await readHooksJsonRemote(sftp, remoteConfigPath)
      if (!config) {
        return errorStatus(remoteConfigPath, 'Could not parse remote Auggie settings.json')
      }
      const hook = getManagedHook(remoteScriptPath)
      const nextConfig = applyManagedHooks(config, hook, remoteScriptFileName)
      // Write the script first so settings.json never points at a missing script.
      await writeManagedScriptRemote(sftp, remoteScriptPath, getManagedScript('posix'))
      await writeHooksJsonRemote(sftp, remoteConfigPath, nextConfig)
      return {
        agent: 'aug',
        state: 'installed',
        configPath: remoteConfigPath,
        managedHooksPresent: true,
        detail: null
      }
    } catch (err) {
      return errorStatus(remoteConfigPath, err instanceof Error ? err.message : String(err))
    }
  }

  remove(): AgentHookInstallStatus {
    const configPath = getConfigPath()
    const config = readHooksJson(configPath)
    if (!config) {
      return errorStatus(configPath, PARSE_ERROR_DETAIL)
    }
    const { config: nextConfig, changed } = removeManagedHooks(config, getManagedScriptFileName())
    if (changed) {
      writeHooksJson(configPath, nextConfig)
    }
    return this.getStatus()
  }
}

export const auggieHookService = new AuggieHookService()
