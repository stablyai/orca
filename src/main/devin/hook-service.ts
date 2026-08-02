import type { SFTPWrapper } from 'ssh2'
import type { AgentHookInstallState, AgentHookInstallStatus } from '../../shared/agent-hook-types'
import {
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
  buildPosixHookPayloadCapture,
  buildWindowsHookEnvironmentGuardLines,
  buildWindowsHookStdinDrainEpilogue
} from '../agent-hooks/hook-stdin-contract'
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
  readDevinHooksConfig
} from './hook-config-json'

function getManagedScript(target: 'local' | 'posix' = 'local'): string {
  if (target === 'local' && process.platform === 'win32') {
    return [
      '@echo off',
      'setlocal',
      // Why: endpoint file holds the live port/token; a PTY that outlives an Orca restart carries stale env, so `call` it to refresh (else PTY env).
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
    // Why: endpoint file holds the live port/token; PTYs that outlive an Orca restart carry stale env, so source it to reach the new server (else PTY env).
    // Why: silence the `.` builtin (2>/dev/null + `|| :`) so a TOCTOU race or CRLF-mangled line can't leak shell parse errors into agent transcripts (fail-open).
    'if [ -n "$ORCA_AGENT_HOOK_ENDPOINT" ] && [ -r "$ORCA_AGENT_HOOK_ENDPOINT" ]; then',
    '  . "$ORCA_AGENT_HOOK_ENDPOINT" 2>/dev/null || :',
    'fi',
    'if [ -z "$ORCA_AGENT_HOOK_PORT" ] || [ -z "$ORCA_AGENT_HOOK_TOKEN" ] || [ -z "$ORCA_PANE_KEY" ]; then',
    '  exit 0',
    'fi',
    // Why: worktreeId embeds a filesystem path, so hand-building JSON in shell is unsafe (quotes/newlines); post as form fields instead.
    // Why: pipe payload to curl's stdin (payload@-) not an inline arg, so large tool output stays off the command line (EDR false positives).
    'printf \'%s\' "$payload" | curl -sS -X POST "http://127.0.0.1:${ORCA_AGENT_HOOK_PORT}/hook/devin" \\',
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

export class DevinHookService {
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

    // Why: report `partial` when only some managed events are registered, so the sidebar shows a degraded install instead of a false `installed`.
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
    const nextConfig = applyDevinManagedHooks(config, command, getDevinManagedScriptFileName())
    writeManagedScript(scriptPath, getManagedScript())
    writeHooksJson(configPath, nextConfig)
    return this.getStatus()
  }

  // Why: install the Devin hook on the remote box (SFTP handle + resolved remote $HOME); POSIX-only by design.
  async installRemote(sftp: SFTPWrapper, remoteHome: string): Promise<AgentHookInstallStatus> {
    // Why: remote-Windows is out of scope for v1; process.platform here is the local box, not the remote, so assume POSIX.
    const remoteConfigPath = getDevinRemoteConfigPath(remoteHome)
    const remoteScriptFileName = getDevinPosixManagedScriptFileName()
    const remoteScriptPath = `${remoteHome.replace(/\/$/, '')}/.orca/agent-hooks/${remoteScriptFileName}`
    // Why: SFTP I/O fails far more often than local fs; wrap the flow so failures surface as a structured error, not an unhandled rejection.
    try {
      // Why: Devin config.json is JSONC (comments), so JSON.parse rejects it; parse via jsonc-parser.
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

      // Why: the POSIX wrapper body is path-independent, so reuse the same helper.
      const command = getDevinRemoteManagedCommand(remoteScriptPath)
      const nextConfig = applyDevinManagedHooks(config, command, remoteScriptFileName)

      // Why: write script before settings so a mid-install failure never leaves settings.json referencing a missing script.
      // Why: SSH remotes use POSIX `.sh` hooks even when Orca runs on Windows; never derive remote script syntax from local OS.
      await writeManagedScriptRemote(sftp, remoteScriptPath, getManagedScript('posix'))
      await writeHooksJsonRemote(sftp, remoteConfigPath, nextConfig)

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
    const { config: nextConfig, changed } = removeDevinManagedHooks(
      config,
      getDevinManagedScriptFileName()
    )
    if (changed) {
      writeHooksJson(configPath, nextConfig)
    }
    return this.getStatus()
  }
}

export const devinHookService = new DevinHookService()
