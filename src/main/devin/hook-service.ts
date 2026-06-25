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
      // Why: the endpoint file holds the *live* port/token for this Orca
      // install. A PTY that survived an Orca restart has stale PORT/TOKEN
      // baked into its env from the old instance — loading `endpoint.cmd`
      // (`set KEY=VALUE` lines) via `call` refreshes them so the hook
      // reaches the current server. Falls through to PTY env if the file
      // is missing (first run / pre-endpoint-file / running outside Orca).
      'if defined ORCA_AGENT_HOOK_ENDPOINT if exist "%ORCA_AGENT_HOOK_ENDPOINT%" call "%ORCA_AGENT_HOOK_ENDPOINT%" 2>nul',
      'if "%ORCA_AGENT_HOOK_PORT%"=="" exit /b 0',
      'if "%ORCA_AGENT_HOOK_TOKEN%"=="" exit /b 0',
      'if "%ORCA_PANE_KEY%"=="" exit /b 0',
      buildWindowsAgentHookPostCommand('devin'),
      'exit /b 0',
      ''
    ].join('\r\n')
  }

  return [
    '#!/bin/sh',
    // Why: the endpoint file holds the *live* port/token for this Orca
    // install. PTYs that survive an Orca restart have stale PORT/TOKEN
    // baked into their env from the old instance — sourcing the file here
    // lets us reach the new server. Falls back to PTY env if the file is
    // missing (first-run / pre-endpoint-file scripts / running outside Orca).
    // Why: suppress stderr on the `.` builtin. A TOCTOU race (endpoint unlinked
    // between the `[ -r ]` test and the source) or a malformed line (e.g. CRLF
    // bled in from a cross-platform userData copy) would otherwise print a
    // parse error that agent transcripts could surface. Stale coords → dead
    // port → silent-fail is the documented fail-open path anyway — the env-var
    // guards below handle the empty PORT/TOKEN case — so swallowing the noise
    // here is strictly better than leaking shell errors into the hook output.
    // `|| :` defends against an eventual `set -e` in an outer script context
    // (not present today) aborting the hook on a parse error.
    'if [ -n "$ORCA_AGENT_HOOK_ENDPOINT" ] && [ -r "$ORCA_AGENT_HOOK_ENDPOINT" ]; then',
    '  . "$ORCA_AGENT_HOOK_ENDPOINT" 2>/dev/null || :',
    'fi',
    'if [ -z "$ORCA_AGENT_HOOK_PORT" ] || [ -z "$ORCA_AGENT_HOOK_TOKEN" ] || [ -z "$ORCA_PANE_KEY" ]; then',
    '  exit 0',
    'fi',
    'payload=$(cat)',
    'if [ -z "$payload" ]; then',
    '  exit 0',
    'fi',
    // Why: worktreeId embeds a filesystem path, so hand-building JSON in POSIX
    // shell is not safe once a path contains quotes or newlines. Post the raw
    // hook payload plus metadata as form fields and let the receiver parse it.
    // Timeout caps best-effort hook posts if the local listener stalls.
    'curl -sS -X POST "http://127.0.0.1:${ORCA_AGENT_HOOK_PORT}/hook/devin" \\',
    '  --connect-timeout 0.5 --max-time 1.5 \\',
    '  -H "Content-Type: application/x-www-form-urlencoded" \\',
    '  -H "X-Orca-Agent-Hook-Token: ${ORCA_AGENT_HOOK_TOKEN}" \\',
    '  --data-urlencode "paneKey=${ORCA_PANE_KEY}" \\',
    '  --data-urlencode "tabId=${ORCA_TAB_ID}" \\',
    '  --data-urlencode "launchToken=${ORCA_AGENT_LAUNCH_TOKEN}" \\',
    '  --data-urlencode "worktreeId=${ORCA_WORKTREE_ID}" \\',
    '  --data-urlencode "env=${ORCA_AGENT_HOOK_ENV}" \\',
    '  --data-urlencode "version=${ORCA_AGENT_HOOK_VERSION}" \\',
    '  --data-urlencode "payload=${payload}" >/dev/null 2>&1 || true',
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

    // Why: Report `partial` when only some managed events are registered so the
    // sidebar surfaces a degraded install rather than a false-positive
    // `installed`. Each DEVIN_EVENTS entry must contain the managed command for
    // the integration to function end-to-end.
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

  // Why: install Orca's Devin hook settings on the remote box rather than the
  // local machine. Caller passes the user's SFTP handle plus the resolved
  // remote `$HOME`; POSIX-only by design (Windows-remote deferred).
  async installRemote(sftp: SFTPWrapper, remoteHome: string): Promise<AgentHookInstallStatus> {
    // Why: remote-Windows is out of scope for v1 — we ship POSIX-shaped paths
    // and a `.sh` managed script body. The remote platform is gated by the
    // relay's capability RPC at a higher layer; we cannot detect it from
    // `process.platform` here (that's the local box).
    const remoteConfigPath = getDevinRemoteConfigPath(remoteHome)
    const remoteScriptFileName = getDevinPosixManagedScriptFileName()
    const remoteScriptPath = `${remoteHome.replace(/\/$/, '')}/.orca/agent-hooks/${remoteScriptFileName}`
    // Why: SFTP reads/writes fail far more often than local fs (network drops,
    // EACCES on remote dirs, disk full, channel closed). Wrap the entire
    // install flow in try/catch so a transient I/O failure surfaces as a
    // structured `state: 'error'` result for the UI, not an unstructured
    // rejection the caller has to remember to handle. A `null` config
    // specifically means "file present but unparseable" — keep that branch
    // distinct so the user sees an actionable message.
    try {
      // Why: Devin config.json is JSONC (comments); stock
      // JSON.parse rejects them. Read the raw text via SFTP and parse with
      // jsonc-parser, mirroring the local readDevinHooksConfig path.
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

      // Why: the POSIX wrapper is identical regardless of where the script
      // lands; only the path differs. Reuse the same wrapper helper.
      const command = getDevinRemoteManagedCommand(remoteScriptPath)
      const nextConfig = applyDevinManagedHooks(config, command, remoteScriptFileName)

      // Why: write the script first, then the settings — settings.json
      // referencing a missing script body would fire `command not found` on
      // every tool call until the user re-runs install. Doing it in this
      // order means a partial-failure mid-install at worst leaves the user
      // with a working script no settings.json points at (a no-op), instead
      // of broken settings.json.
      // Why: SSH remotes use POSIX `.sh` hook paths even when Orca itself is
      // running on Windows; never derive remote script syntax from local OS.
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
