import { existsSync, rmSync, writeFileSync } from 'node:fs'
import type { SFTPWrapper } from 'ssh2'
import type { AgentHookInstallState, AgentHookInstallStatus } from '../../shared/agent-hook-types'
import {
  buildManagedCommandHook,
  buildWindowsAgentHookCurlPostCommand,
  readHooksJson,
  writeHooksJson,
  writeManagedScript,
  type HooksConfig
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
  buildWindowsHookStdinDrainEpilogue,
  WINDOWS_HOOK_STDIN_DRAIN_LABEL
} from '../agent-hooks/hook-stdin-contract'
import { getManagedStatusLineScript } from './statusline-script'
import {
  applyManagedHooks,
  applyManagedStatusLine,
  CLAUDE_EVENTS,
  CLAUDE_HOOK_SETTINGS,
  getManagedScriptFileName,
  getConfigPath,
  getManagedCommand,
  getManagedLifecycleHook,
  getManagedScriptPath,
  getPosixManagedScriptFileName,
  getRemoteConfigPath,
  getRemoteManagedCommand,
  getStatusLineInstallMarkerPath,
  getStatusLineScriptFileName,
  getStatusLineScriptPath,
  getStatusLineSlotState,
  hasSameManagedHookInvocation,
  removeManagedHooks,
  removeManagedStatusLine,
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

function getManagedScript(
  target: 'local' | 'posix' = 'local',
  options: { skipWhenDevinImportsClaude?: boolean } = {}
): string {
  if (target === 'local' && process.platform === 'win32') {
    return [
      '@echo off',
      'setlocal',
      // Why: Claude-compatible permission hooks fail closed on empty stdout (#14818).
      'echo {}',
      // Why: refresh endpoint coordinates for PTYs surviving an Orca restart.
      'if defined ORCA_AGENT_HOOK_ENDPOINT if exist "%ORCA_AGENT_HOOK_ENDPOINT%" call "%ORCA_AGENT_HOOK_ENDPOINT%" 2>nul',
      // Why (#11549): the env guards must outrank the Devin skip — the Devin skip parks in more.com,
      // and outside an Orca pane the caller can abandon stdin, so more.com never returns.
      ...buildWindowsHookEnvironmentGuardLines(),
      ...(options.skipWhenDevinImportsClaude
        ? [
            // Why: Devin imports .claude hooks by default; skip Orca's managed hook there so status posts stay attributed to Devin.
            `if not "%DEVIN_PROJECT_DIR%"=="" goto :${WINDOWS_HOOK_STDIN_DRAIN_LABEL}`
          ]
        : []),
      // Why: use curl.exe to avoid an extra PowerShell startup per hook.
      buildWindowsAgentHookCurlPostCommand('claude'),
      'exit /b 0',
      ...buildWindowsHookStdinDrainEpilogue(),
      ''
    ].join('\r\n')
  }

  return [
    '#!/bin/sh',
    // Why: Claude-compatible permission hooks fail closed on empty stdout (#14818).
    'printf "{}\\n"',
    ...buildPosixHookPayloadCapture(),
    ...(options.skipWhenDevinImportsClaude
      ? [
          // Why: Devin imports .claude hooks by default; skip Orca's managed hook there so status posts stay attributed to Devin.
          'if [ -n "$DEVIN_PROJECT_DIR" ]; then',
          '  exit 0',
          'fi'
        ]
      : []),
    // Why: refresh endpoint coordinates for PTYs surviving an Orca restart.
    // Why: suppress parse errors so they neither leak nor trip outer set -e.
    'if [ -n "$ORCA_AGENT_HOOK_ENDPOINT" ] && [ -r "$ORCA_AGENT_HOOK_ENDPOINT" ]; then',
    '  . "$ORCA_AGENT_HOOK_ENDPOINT" 2>/dev/null || :',
    'fi',
    'if [ -z "$ORCA_AGENT_HOOK_PORT" ] || [ -z "$ORCA_AGENT_HOOK_TOKEN" ] || [ -z "$ORCA_PANE_KEY" ]; then',
    '  exit 0',
    'fi',
    // Why: post form fields because path-bearing payloads are unsafe in hand-built JSON.
    // Why: pipe payload to curl stdin to keep large output off the command line.
    'printf \'%s\' "$payload" | curl -sS -X POST "http://127.0.0.1:${ORCA_AGENT_HOOK_PORT}/hook/claude" \\',
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

    // Why: report partial registration instead of a false installed state.
    const expectedHook = getManagedLifecycleHook(scriptPath, this.options.settings)
    const missing: string[] = []
    let presentCount = 0
    for (const event of CLAUDE_EVENTS) {
      const definitions = Array.isArray(config.hooks?.[event.eventName])
        ? config.hooks![event.eventName]!
        : []
      const hasCommand = definitions.some((definition) =>
        (definition.hooks ?? []).some((hook) => hasSameManagedHookInvocation(hook, expectedHook))
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

  async refreshManagedScripts(): Promise<void> {
    await refreshManagedScriptIfPresent(
      getManagedScriptPath(this.options.settings),
      getManagedScript('local', { skipWhenDevinImportsClaude: this.options.agent === 'claude' })
    )
    // Why: no agent gate — the statusline script only ever exists for claude, so presence is the gate.
    await refreshManagedScriptIfPresent(
      getStatusLineScriptPath(this.options.settings),
      getManagedStatusLineScript('local')
    )
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

    const hook = getManagedLifecycleHook(scriptPath, this.options.settings)
    let nextConfig = applyManagedHooks(
      config,
      hook,
      getManagedScriptFileName(this.options.settings)
    )
    writeManagedScript(
      scriptPath,
      getManagedScript('local', { skipWhenDevinImportsClaude: this.options.agent === 'claude' })
    )
    // Why: the statusline usage feed is Claude-only — OpenClaude data would be misattributed to the Claude provider.
    if (this.options.agent === 'claude') {
      nextConfig = this.installManagedStatusLine(nextConfig)
    }
    writeHooksJson(configPath, nextConfig)
    return this.getStatus()
  }

  // Why: the statusline feed is opportunistic (usage display, not agent status); a user who deleted the
  // managed entry has opted out, and the marker distinguishes that deletion from a first install.
  private installManagedStatusLine(config: HooksConfig): HooksConfig {
    const scriptFileName = getStatusLineScriptFileName(this.options.settings)
    const markerPath = getStatusLineInstallMarkerPath(this.options.settings)
    const slot = getStatusLineSlotState(config, scriptFileName)
    if (slot === 'user' || (slot === 'empty' && existsSync(markerPath))) {
      return config
    }
    const statusLineScriptPath = getStatusLineScriptPath(this.options.settings)
    writeManagedScript(statusLineScriptPath, getManagedStatusLineScript('local'))
    const next = applyManagedStatusLine(
      config,
      getManagedCommand(statusLineScriptPath),
      scriptFileName
    )
    try {
      writeFileSync(markerPath, '')
    } catch {
      // Best-effort: a missing marker only means one future user deletion gets re-installed once.
    }
    return next
  }

  // Why: install the Claude hook on the remote box (via SFTP); POSIX-only by design (Windows-remote deferred).
  async installRemote(sftp: SFTPWrapper, remoteHome: string): Promise<AgentHookInstallStatus> {
    // Why: remote Windows is unsupported; local process.platform cannot identify the remote OS.
    const remoteConfigPath = getRemoteConfigPath(remoteHome, this.options.settings)
    const remoteScriptFileName = getPosixManagedScriptFileName(this.options.settings)
    const remoteScriptPath = `${remoteHome.replace(/\/$/, '')}/.orca/agent-hooks/${remoteScriptFileName}`
    // Why: surface fallible SFTP installs as structured errors.
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

      // Why: settings resolve HOME at runtime while SFTP still targets the discovered remote home.
      const hook = buildManagedCommandHook(getRemoteManagedCommand(remoteScriptPath))
      const nextConfig = applyManagedHooks(config, hook, remoteScriptFileName)

      // Why: write scripts before settings to avoid settings pointing to missing scripts.
      // Why: SSH scripts always use POSIX .sh paths, regardless of the local OS.
      await writeManagedScriptRemote(
        sftp,
        remoteScriptPath,
        getManagedScript('posix', { skipWhenDevinImportsClaude: this.options.agent === 'claude' })
      )
      // Why: no statusline install here — this path serves SSH remotes and WSL guests, whose relay hook
      // listener doesn't route /statusline/claude, and an SSH box's Claude login can be a different
      // account than the locally selected one, so its usage must not feed the local bar (live feed is host-local only).
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
    const { config: hooksRemoved, changed: hooksChanged } = removeManagedHooks(
      config,
      getManagedScriptFileName(this.options.settings)
    )
    const { config: nextConfig, changed: statusLineChanged } = removeManagedStatusLine(
      hooksRemoved,
      getStatusLineScriptFileName(this.options.settings)
    )
    if (hooksChanged || statusLineChanged) {
      writeHooksJson(configPath, nextConfig)
    }
    if (this.options.agent === 'claude') {
      try {
        // Why: an Orca-level uninstall resets the opt-out memory so a later re-enable installs the statusline again.
        rmSync(getStatusLineInstallMarkerPath(this.options.settings), { force: true })
      } catch {
        // ignore — marker cleanup is best-effort
      }
    }
    return this.getStatus()
  }
}

export const claudeHookService = new ClaudeHookService()
