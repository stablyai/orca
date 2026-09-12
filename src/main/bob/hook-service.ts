import type { SFTPWrapper } from 'ssh2'
import type { AgentHookInstallState, AgentHookInstallStatus } from '../../shared/agent-hook-types'
import {
  buildWindowsAgentHookPostCommand,
  readHooksJson,
  writeHooksJson,
  writeManagedScript,
  type HooksConfig
} from '../agent-hooks/installer-utils'
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
import { refreshManagedScriptIfPresent } from '../agent-hooks/managed-hook-script-refresh'
import {
  applyBobManagedHooks,
  BOB_EVENTS,
  getBobConfigPath,
  getBobManagedCommand,
  getBobManagedScriptPath,
  getBobPosixManagedScriptFileName,
  getBobRemoteConfigPath,
  getBobRemoteManagedCommand,
  removeBobManagedHooks
} from './hook-settings'

const PARSE_ERROR_DETAIL = 'Could not parse Bob settings.json'

function getManagedScript(target: 'local' | 'posix' = 'local'): string {
  if (target === 'local' && process.platform === 'win32') {
    return [
      '@echo off',
      'setlocal',
      // Why: endpoint file holds the live port/token; a PTY that outlives an Orca restart carries stale env, so `call` it to refresh (else PTY env).
      'if defined ORCA_AGENT_HOOK_ENDPOINT if exist "%ORCA_AGENT_HOOK_ENDPOINT%" call "%ORCA_AGENT_HOOK_ENDPOINT%" 2>nul',
      ...buildWindowsHookEnvironmentGuardLines(),
      buildWindowsAgentHookPostCommand('bob'),
      'exit /b 0',
      ...buildWindowsHookStdinDrainEpilogue(),
      ''
    ].join('\r\n')
  }

  return [
    '#!/bin/sh',
    ...buildPosixHookPayloadCapture(),
    ...buildPosixHookSpoolLines('bob'),
    // Why: endpoint file holds the live port/token; PTYs that outlive an Orca restart carry stale env, so source it to reach the new server (else PTY env).
    'if [ -n "$ORCA_AGENT_HOOK_ENDPOINT" ] && [ -r "$ORCA_AGENT_HOOK_ENDPOINT" ]; then',
    '  . "$ORCA_AGENT_HOOK_ENDPOINT" 2>/dev/null || :',
    'fi',
    'if [ -z "$ORCA_AGENT_HOOK_PORT" ] || [ -z "$ORCA_AGENT_HOOK_TOKEN" ] || [ -z "$ORCA_PANE_KEY" ]; then',
    '  spool_hook_event',
    '  exit 0',
    'fi',
    // Why: worktreeId embeds a filesystem path, so hand-building JSON in shell is unsafe (quotes/newlines); post as form fields instead.
    'printf \'%s\' "$payload" | curl -sS -X POST "http://127.0.0.1:${ORCA_AGENT_HOOK_PORT}/hook/bob" \\',
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

export class BobHookService {
  async refreshManagedScripts(): Promise<void> {
    await refreshManagedScriptIfPresent(getBobManagedScriptPath(), getManagedScript())
  }

  getStatus(): AgentHookInstallStatus {
    const configPath = getBobConfigPath()
    const config = readHooksJson(configPath)
    if (!config) {
      return {
        agent: 'bob',
        state: 'error',
        configPath,
        managedHooksPresent: false,
        detail: PARSE_ERROR_DETAIL
      }
    }

    // Why: report `partial` when only some managed events are registered, so the sidebar shows a degraded install instead of a false `installed`.
    const command = getBobManagedCommand(getBobManagedScriptPath())
    const missing: string[] = []
    let presentCount = 0
    for (const eventName of BOB_EVENTS) {
      const definitions = Array.isArray(config.hooks?.[eventName]) ? config.hooks![eventName]! : []
      const hasCommand = definitions.some((definition) =>
        (definition.hooks ?? []).some((hook) => hook.command === command)
      )
      if (hasCommand) {
        presentCount += 1
      } else {
        missing.push(eventName)
      }
    }

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
      agent: 'bob',
      state,
      configPath,
      managedHooksPresent: presentCount > 0,
      detail
    }
  }

  install(): AgentHookInstallStatus {
    const configPath = getBobConfigPath()
    const scriptPath = getBobManagedScriptPath()
    const config = readHooksJson(configPath)
    if (!config) {
      return {
        agent: 'bob',
        state: 'error',
        configPath,
        managedHooksPresent: false,
        detail: PARSE_ERROR_DETAIL
      }
    }

    const nextConfig = applyBobManagedHooks(config, getBobManagedCommand(scriptPath))
    // Why: write the script first so a mid-install failure never leaves settings.json pointing at a missing file.
    writeManagedScript(scriptPath, getManagedScript())
    writeHooksJson(configPath, nextConfig)
    return this.getStatus()
  }

  // Why: install the Bob hook on the remote box (SFTP handle + resolved remote $HOME); POSIX-only by design.
  async installRemote(sftp: SFTPWrapper, remoteHome: string): Promise<AgentHookInstallStatus> {
    const remoteConfigPath = getBobRemoteConfigPath(remoteHome)
    const remoteScriptFileName = getBobPosixManagedScriptFileName()
    const remoteScriptPath = `${remoteHome.replace(/\/$/, '')}/.orca/agent-hooks/${remoteScriptFileName}`
    // Why: SFTP I/O fails far more often than local fs; wrap the flow so failures surface as a structured error, not an unhandled rejection.
    try {
      const body = await readTextFileRemote(sftp, remoteConfigPath)
      let config: HooksConfig
      if (body === null) {
        config = {}
      } else {
        try {
          config = JSON.parse(body) as HooksConfig
        } catch {
          return {
            agent: 'bob',
            state: 'error',
            configPath: remoteConfigPath,
            managedHooksPresent: false,
            detail: 'Could not parse remote Bob settings.json'
          }
        }
      }

      const nextConfig = applyBobManagedHooks(
        config,
        getBobRemoteManagedCommand(remoteScriptPath),
        remoteScriptFileName
      )
      // Why: SSH remotes use POSIX `.sh` hooks even when Orca runs on Windows; never derive remote script syntax from local OS.
      await writeManagedScriptRemote(sftp, remoteScriptPath, getManagedScript('posix'))
      await writeHooksJsonRemote(sftp, remoteConfigPath, nextConfig)

      return {
        agent: 'bob',
        state: 'installed',
        configPath: remoteConfigPath,
        managedHooksPresent: true,
        detail: null
      }
    } catch (err) {
      return {
        agent: 'bob',
        state: 'error',
        configPath: remoteConfigPath,
        managedHooksPresent: false,
        detail: err instanceof Error ? err.message : String(err)
      }
    }
  }

  remove(): AgentHookInstallStatus {
    const configPath = getBobConfigPath()
    const config = readHooksJson(configPath)
    if (!config) {
      return {
        agent: 'bob',
        state: 'error',
        configPath,
        managedHooksPresent: false,
        detail: PARSE_ERROR_DETAIL
      }
    }
    const { config: nextConfig, changed } = removeBobManagedHooks(config)
    if (changed) {
      writeHooksJson(configPath, nextConfig)
    }
    return this.getStatus()
  }
}

export const bobHookService = new BobHookService()
