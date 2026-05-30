import type { SFTPWrapper } from 'ssh2'
import type { AgentHookInstallState, AgentHookInstallStatus } from '../../shared/agent-hook-types'
import {
  buildWindowsAgentHookPostCommand,
  readHooksJson,
  writeHooksJson,
  writeManagedScript
} from '../agent-hooks/installer-utils'
import {
  readHooksJsonRemote,
  writeHooksJsonRemote,
  writeManagedScriptRemote
} from '../agent-hooks/installer-utils-remote'
import {
  applyManagedHooks,
  CLAUDE_EVENTS,
  CLAUDE_HOOK_SETTINGS,
  getManagedScriptFileName,
  getConfigPath,
  getManagedCommand,
  getManagedScriptPath,
  getPosixManagedScriptFileName,
  getRemoteConfigPath,
  getRemoteManagedCommand,
  removeManagedHooks,
  type ClaudeCompatibleHookSettings
} from './hook-settings'

type ClaudeHookServiceOptions = {
  agent: AgentHookInstallStatus['agent']
  displayName: string
  settings: ClaudeCompatibleHookSettings
}

const DEFAULT_CLAUDE_HOOK_SERVICE_OPTIONS: ClaudeHookServiceOptions = {
  agent: 'claude',
  displayName: 'Claude',
  settings: CLAUDE_HOOK_SETTINGS
}

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
      buildWindowsAgentHookPostCommand('claude'),
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
    'curl -sS -X POST "http://127.0.0.1:${ORCA_AGENT_HOOK_PORT}/hook/claude" \\',
    '  -H "Content-Type: application/x-www-form-urlencoded" \\',
    '  -H "X-Orca-Agent-Hook-Token: ${ORCA_AGENT_HOOK_TOKEN}" \\',
    '  --data-urlencode "paneKey=${ORCA_PANE_KEY}" \\',
    '  --data-urlencode "tabId=${ORCA_TAB_ID}" \\',
    '  --data-urlencode "worktreeId=${ORCA_WORKTREE_ID}" \\',
    '  --data-urlencode "env=${ORCA_AGENT_HOOK_ENV}" \\',
    '  --data-urlencode "version=${ORCA_AGENT_HOOK_VERSION}" \\',
    '  --data-urlencode "payload=${payload}" >/dev/null 2>&1 || true',
    'exit 0',
    ''
  ].join('\n')
}

export class ClaudeHookService {
  private readonly options: ClaudeHookServiceOptions

  constructor(options: ClaudeHookServiceOptions = DEFAULT_CLAUDE_HOOK_SERVICE_OPTIONS) {
    this.options = options
  }

  getStatus(): AgentHookInstallStatus {
    const configPath = getConfigPath(this.options.settings)
    const scriptPath = getManagedScriptPath(this.options.settings)
    const config = readHooksJson(configPath)
    if (!config) {
      return {
        agent: this.options.agent,
        state: 'error',
        configPath,
        managedHooksPresent: false,
        detail: `Could not parse ${this.options.displayName} settings.json`
      }
    }

    // Why: Report `partial` when only some managed events are registered so the
    // sidebar surfaces a degraded install rather than a false-positive
    // `installed`. Each CLAUDE_EVENTS entry must contain the managed command for
    // the integration to function end-to-end.
    const command = getManagedCommand(scriptPath)
    const missing: string[] = []
    let presentCount = 0
    for (const event of CLAUDE_EVENTS) {
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
    return { agent: this.options.agent, state, configPath, managedHooksPresent, detail }
  }

  install(): AgentHookInstallStatus {
    const configPath = getConfigPath(this.options.settings)
    const scriptPath = getManagedScriptPath(this.options.settings)
    const config = readHooksJson(configPath)
    if (!config) {
      return {
        agent: this.options.agent,
        state: 'error',
        configPath,
        managedHooksPresent: false,
        detail: `Could not parse ${this.options.displayName} settings.json`
      }
    }

    const command = getManagedCommand(scriptPath)
    const nextConfig = applyManagedHooks(
      config,
      command,
      getManagedScriptFileName(this.options.settings)
    )
    writeManagedScript(scriptPath, getManagedScript())
    writeHooksJson(configPath, nextConfig)
    return this.getStatus()
  }

  // Why: install Orca's Claude hook settings on the remote box rather than the
  // local machine. Caller passes the user's SFTP handle plus the resolved
  // remote `$HOME`; POSIX-only by design (Windows-remote deferred).
  async installRemote(sftp: SFTPWrapper, remoteHome: string): Promise<AgentHookInstallStatus> {
    // Why: remote-Windows is out of scope for v1 — we ship POSIX-shaped paths
    // and a `.sh` managed script body. The remote platform is gated by the
    // relay's capability RPC at a higher layer; we cannot detect it from
    // `process.platform` here (that's the local box).
    const remoteConfigPath = getRemoteConfigPath(remoteHome, this.options.settings)
    const remoteScriptFileName = getPosixManagedScriptFileName(this.options.settings)
    const remoteScriptPath = `${remoteHome.replace(/\/$/, '')}/.orca/agent-hooks/${remoteScriptFileName}`
    // Why: SFTP reads/writes fail far more often than local fs (network drops,
    // EACCES on remote dirs, disk full, channel closed). Wrap the entire
    // install flow in try/catch so a transient I/O failure surfaces as a
    // structured `state: 'error'` result for the UI, not an unstructured
    // rejection the caller has to remember to handle. A `null` config
    // specifically means "file present but unparseable" — keep that branch
    // distinct so the user sees an actionable message.
    try {
      const config = await readHooksJsonRemote(sftp, remoteConfigPath)
      if (!config) {
        return {
          agent: this.options.agent,
          state: 'error',
          configPath: remoteConfigPath,
          managedHooksPresent: false,
          detail: `Could not parse remote ${this.options.displayName} settings.json`
        }
      }

      // Why: the POSIX wrapper is identical regardless of where the script
      // lands; only the path differs. Reuse the same wrapper helper.
      const command = getRemoteManagedCommand(remoteScriptPath)
      const nextConfig = applyManagedHooks(config, command, remoteScriptFileName)

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
        agent: this.options.agent,
        state: 'installed',
        configPath: remoteConfigPath,
        managedHooksPresent: true,
        detail: null
      }
    } catch (err) {
      return {
        agent: this.options.agent,
        state: 'error',
        configPath: remoteConfigPath,
        managedHooksPresent: false,
        detail: err instanceof Error ? err.message : String(err)
      }
    }
  }

  remove(): AgentHookInstallStatus {
    const configPath = getConfigPath(this.options.settings)
    const config = readHooksJson(configPath)
    if (!config) {
      return {
        agent: this.options.agent,
        state: 'error',
        configPath,
        managedHooksPresent: false,
        detail: `Could not parse ${this.options.displayName} settings.json`
      }
    }
    const { config: nextConfig, changed } = removeManagedHooks(
      config,
      getManagedScriptFileName(this.options.settings)
    )
    if (changed) {
      writeHooksJson(configPath, nextConfig)
    }
    return this.getStatus()
  }
}

export const claudeHookService = new ClaudeHookService()
