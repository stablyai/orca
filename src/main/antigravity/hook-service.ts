/* eslint-disable max-lines -- Why: local Antigravity install, Windows wrapper
   generation, status cleanup, and SSH remote install must share one event list
   and managed-command matcher so stale hook cleanup cannot drift by platform. */
import { homedir } from 'os'
import { join } from 'path'
import type { SFTPWrapper } from 'ssh2'
import type { AgentHookInstallState, AgentHookInstallStatus } from '../../shared/agent-hook-types'
import {
  createManagedCommandMatcher,
  getSharedManagedScriptPath,
  hookDefinitionHasManagedCommand,
  readHooksJson,
  removeManagedCommands,
  wrapPosixHookCommand,
  writeHooksJson,
  writeManagedScript,
  type HookDefinition,
  type HooksConfig
} from '../agent-hooks/installer-utils'
import {
  readHooksJsonRemote,
  writeHooksJsonRemote,
  writeManagedScriptRemote
} from '../agent-hooks/installer-utils-remote'

const ANTIGRAVITY_HOOK_BUNDLE_NAME = 'orca-status'

const ANTIGRAVITY_EVENTS = [
  {
    eventName: 'PreInvocation',
    schema: 'direct',
    windowsWrapperFileName: 'antigravity-pre-invocation.cmd'
  },
  {
    eventName: 'PostInvocation',
    schema: 'direct',
    windowsWrapperFileName: 'antigravity-post-invocation.cmd'
  },
  { eventName: 'Stop', schema: 'direct', windowsWrapperFileName: 'antigravity-stop.cmd' },
  // Why: Antigravity requires PreToolUse hooks to make permission decisions.
  // Orca's hook is observational, so installing there can block user tools.
  {
    eventName: 'PostToolUse',
    schema: 'tool',
    windowsWrapperFileName: 'antigravity-post-tool-use.cmd'
  }
] as const

type AntigravityEvent = (typeof ANTIGRAVITY_EVENTS)[number]

const ANTIGRAVITY_MANAGED_SCRIPT_FILE_NAMES = [
  'antigravity-hook.sh',
  'antigravity-hook.cmd',
  ...ANTIGRAVITY_EVENTS.map((event) => event.windowsWrapperFileName)
] as const

function getConfigPath(): string {
  // Why: Antigravity's hook docs define global hooks in ~/.gemini/config/hooks.json,
  // not in the CLI settings file used by Gemini CLI.
  return join(homedir(), '.gemini', 'config', 'hooks.json')
}

function getManagedScriptFileName(): string {
  return process.platform === 'win32' ? 'antigravity-hook.cmd' : 'antigravity-hook.sh'
}

function getManagedScriptPath(): string {
  return getSharedManagedScriptPath(getManagedScriptFileName())
}

function getWindowsWrapperScriptPath(event: AntigravityEvent): string {
  return getSharedManagedScriptPath(event.windowsWrapperFileName)
}

function getManagedCommand(scriptPath: string, event: AntigravityEvent): string {
  if (process.platform === 'win32') {
    return getWindowsWrapperScriptPath(event)
  }
  return wrapPosixHookCommand(scriptPath, { ORCA_ANTIGRAVITY_EVENT: event.eventName })
}

function getManagedScript(target: 'local' | 'posix' = 'local'): string {
  if (target === 'local' && process.platform === 'win32') {
    return [
      '@echo off',
      'setlocal',
      'if /I "%ORCA_ANTIGRAVITY_EVENT%"=="Stop" (',
      '  echo {"decision":""}',
      ') else (',
      '  echo {}',
      ')',
      'if defined ORCA_AGENT_HOOK_ENDPOINT if exist "%ORCA_AGENT_HOOK_ENDPOINT%" call "%ORCA_AGENT_HOOK_ENDPOINT%" 2>nul',
      'if "%ORCA_AGENT_HOOK_PORT%"=="" exit /b 0',
      'if "%ORCA_AGENT_HOOK_TOKEN%"=="" exit /b 0',
      'if "%ORCA_PANE_KEY%"=="" exit /b 0',
      buildWindowsAntigravityHookPostCommand(),
      'exit /b 0',
      ''
    ].join('\r\n')
  }

  return [
    '#!/bin/sh',
    'case "$ORCA_ANTIGRAVITY_EVENT" in',
    '  Stop)',
    '    printf \'{"decision":""}\\n\'',
    '    ;;',
    '  *)',
    // Why: Antigravity accepts an empty JSON object for passive status hooks;
    // returning allow/ask/deny from PreToolUse would change the user's tool
    // permission policy.
    '    printf "{}\\n"',
    '    ;;',
    'esac',
    'if [ -n "$ORCA_AGENT_HOOK_ENDPOINT" ] && [ -r "$ORCA_AGENT_HOOK_ENDPOINT" ]; then',
    '  . "$ORCA_AGENT_HOOK_ENDPOINT" 2>/dev/null || :',
    'fi',
    'if [ -z "$ORCA_AGENT_HOOK_PORT" ] || [ -z "$ORCA_AGENT_HOOK_TOKEN" ] || [ -z "$ORCA_PANE_KEY" ]; then',
    '  exit 0',
    'fi',
    'payload=$(cat)',
    'if [ -z "$payload" ]; then',
    // Why: some Antigravity hook events can arrive without stdin. Still post
    // the event name so Orca shows a status row instead of silently dropping it.
    "  payload='{}'",
    'fi',
    // Timeout caps best-effort hook posts if the local listener stalls.
    'curl -sS -X POST "http://127.0.0.1:${ORCA_AGENT_HOOK_PORT}/hook/antigravity" \\',
    '  --connect-timeout 0.5 --max-time 1.5 \\',
    '  -H "Content-Type: application/x-www-form-urlencoded" \\',
    '  -H "X-Orca-Agent-Hook-Token: ${ORCA_AGENT_HOOK_TOKEN}" \\',
    '  --data-urlencode "paneKey=${ORCA_PANE_KEY}" \\',
    '  --data-urlencode "tabId=${ORCA_TAB_ID}" \\',
    '  --data-urlencode "launchToken=${ORCA_AGENT_LAUNCH_TOKEN}" \\',
    '  --data-urlencode "worktreeId=${ORCA_WORKTREE_ID}" \\',
    '  --data-urlencode "env=${ORCA_AGENT_HOOK_ENV}" \\',
    '  --data-urlencode "version=${ORCA_AGENT_HOOK_VERSION}" \\',
    '  --data-urlencode "hook_event_name=${ORCA_ANTIGRAVITY_EVENT}" \\',
    '  --data-urlencode "payload=${payload}" >/dev/null 2>&1 || true',
    'exit 0',
    ''
  ].join('\n')
}

function getWindowsWrapperScript(eventName: string): string {
  return [
    '@echo off',
    'setlocal',
    `set "ORCA_ANTIGRAVITY_EVENT=${eventName}"`,
    'set "ORCA_ANTIGRAVITY_CORE=%~dp0antigravity-hook.cmd"',
    'if exist "%ORCA_ANTIGRAVITY_CORE%" (',
    '  call "%ORCA_ANTIGRAVITY_CORE%"',
    '  exit /b 0',
    ')',
    'if /I "%ORCA_ANTIGRAVITY_EVENT%"=="Stop" (',
    '  echo {"decision":""}',
    ') else (',
    '  echo {}',
    ')',
    'exit /b 0',
    ''
  ].join('\r\n')
}

function buildWindowsAntigravityHookPostCommand(): string {
  // Why: Antigravity hooks are best-effort status updates; do not let a stalled
  // local listener hold the agent process open.
  return `powershell -NoProfile -ExecutionPolicy Bypass -Command "$utf8=[System.Text.UTF8Encoding]::new($false); [Console]::InputEncoding=$utf8; [Console]::OutputEncoding=$utf8; $inputData=[Console]::In.ReadToEnd(); try { $payload=if ([string]::IsNullOrWhiteSpace($inputData)) { @{} } else { $inputData | ConvertFrom-Json }; $body=@{ paneKey=$env:ORCA_PANE_KEY; launchToken=$env:ORCA_AGENT_LAUNCH_TOKEN; tabId=$env:ORCA_TAB_ID; worktreeId=$env:ORCA_WORKTREE_ID; env=$env:ORCA_AGENT_HOOK_ENV; version=$env:ORCA_AGENT_HOOK_VERSION; hook_event_name=$env:ORCA_ANTIGRAVITY_EVENT; payload=$payload } | ConvertTo-Json -Depth 100 -Compress; $bodyBytes=$utf8.GetBytes($body); Invoke-WebRequest -UseBasicParsing -Method Post -Uri ('http://127.0.0.1:' + $env:ORCA_AGENT_HOOK_PORT + '/hook/antigravity') -ContentType 'application/json; charset=utf-8' -Headers @{ 'X-Orca-Agent-Hook-Token'=$env:ORCA_AGENT_HOOK_TOKEN } -Body $bodyBytes -TimeoutSec 2 | Out-Null } catch {}"`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function getBundle(config: HooksConfig): Record<string, unknown> {
  const existing = config[ANTIGRAVITY_HOOK_BUNDLE_NAME]
  return isRecord(existing) ? { ...existing } : {}
}

function hasManagedCommand(definitions: HookDefinition[], command: string): boolean {
  return definitions.some(
    (definition) =>
      definition.command === command ||
      (Array.isArray(definition.hooks) && definition.hooks.some((hook) => hook.command === command))
  )
}

function createAntigravityManagedCommandMatcher(): (command: string | undefined) => boolean {
  const matchers = ANTIGRAVITY_MANAGED_SCRIPT_FILE_NAMES.map((scriptFileName) =>
    createManagedCommandMatcher(scriptFileName)
  )
  return (command) => matchers.some((matcher) => matcher(command))
}

function bundleHasStaleManagedCommand(
  bundle: Record<string, unknown>,
  isManagedCommand: (command: string | undefined) => boolean,
  currentCommands: ReadonlySet<string>
): boolean {
  for (const definitions of Object.values(bundle)) {
    if (!Array.isArray(definitions)) {
      continue
    }
    for (const definition of definitions as HookDefinition[]) {
      if (!hookDefinitionHasManagedCommand(definition, isManagedCommand)) {
        continue
      }
      const commands = [
        definition.command,
        definition.bash,
        definition.powershell,
        ...(Array.isArray(definition.hooks) ? definition.hooks.map((hook) => hook.command) : [])
      ]
      if (
        commands.some(
          (command) =>
            command !== undefined && isManagedCommand(command) && !currentCommands.has(command)
        )
      ) {
        return true
      }
    }
  }
  return false
}

function buildEventDefinition(event: AntigravityEvent, command: string): HookDefinition {
  if (event.schema === 'tool') {
    return {
      matcher: '*',
      hooks: [{ type: 'command', command }]
    }
  }
  return { type: 'command', command }
}

function removeManagedCommandsFromBundle(
  bundle: Record<string, unknown>,
  isManagedCommand: (command: string | undefined) => boolean
): Record<string, unknown> {
  const next = { ...bundle }
  for (const [eventName, definitions] of Object.entries(next)) {
    if (!Array.isArray(definitions)) {
      continue
    }
    const cleaned = removeManagedCommands(definitions as HookDefinition[], isManagedCommand)
    if (cleaned.length === 0) {
      delete next[eventName]
    } else {
      next[eventName] = cleaned
    }
  }
  return next
}

function buildInstalledConfig(
  config: HooksConfig,
  commandForEvent: (event: AntigravityEvent) => string,
  isManagedCommand: (command: string | undefined) => boolean
): void {
  const bundle = removeManagedCommandsFromBundle(getBundle(config), isManagedCommand)

  for (const event of ANTIGRAVITY_EVENTS) {
    const current = Array.isArray(bundle[event.eventName])
      ? (bundle[event.eventName] as HookDefinition[])
      : []
    const cleaned = removeManagedCommands(current, isManagedCommand)
    bundle[event.eventName] = [...cleaned, buildEventDefinition(event, commandForEvent(event))]
  }

  config[ANTIGRAVITY_HOOK_BUNDLE_NAME] = bundle
}

function removeInstalledConfig(config: HooksConfig): void {
  const isManagedCommand = createAntigravityManagedCommandMatcher()
  const bundle = removeManagedCommandsFromBundle(getBundle(config), isManagedCommand)
  if (Object.keys(bundle).length === 0) {
    delete config[ANTIGRAVITY_HOOK_BUNDLE_NAME]
    return
  }
  config[ANTIGRAVITY_HOOK_BUNDLE_NAME] = bundle
}

export class AntigravityHookService {
  getStatus(): AgentHookInstallStatus {
    const configPath = getConfigPath()
    const scriptPath = getManagedScriptPath()
    const config = readHooksJson(configPath)
    if (!config) {
      return {
        agent: 'antigravity',
        state: 'error',
        configPath,
        managedHooksPresent: false,
        detail: 'Could not parse Antigravity hooks.json'
      }
    }

    const bundle = getBundle(config)
    const isManagedCommand = createAntigravityManagedCommandMatcher()
    const currentCommands = new Set(
      ANTIGRAVITY_EVENTS.map((event) => getManagedCommand(scriptPath, event))
    )
    const staleManagedPresent = bundleHasStaleManagedCommand(
      bundle,
      isManagedCommand,
      currentCommands
    )
    const missing: string[] = []
    let presentCount = 0
    for (const event of ANTIGRAVITY_EVENTS) {
      const definitions = Array.isArray(bundle[event.eventName])
        ? (bundle[event.eventName] as HookDefinition[])
        : []
      if (hasManagedCommand(definitions, getManagedCommand(scriptPath, event))) {
        presentCount += 1
      } else {
        missing.push(event.eventName)
      }
    }

    const managedHooksPresent = presentCount > 0 || staleManagedPresent
    let state: AgentHookInstallState
    let detail: string | null
    if (missing.length === 0 && !staleManagedPresent) {
      state = 'installed'
      detail = null
    } else if (presentCount === 0 && !staleManagedPresent) {
      state = 'not_installed'
      detail = null
    } else {
      state = 'partial'
      detail =
        missing.length > 0
          ? `Managed hook missing for events: ${missing.join(', ')}`
          : 'Stale managed hook entries need cleanup'
    }
    return { agent: 'antigravity', state, configPath, managedHooksPresent, detail }
  }

  install(): AgentHookInstallStatus {
    const configPath = getConfigPath()
    const scriptPath = getManagedScriptPath()
    const config = readHooksJson(configPath)
    if (!config) {
      return {
        agent: 'antigravity',
        state: 'error',
        configPath,
        managedHooksPresent: false,
        detail: 'Could not parse Antigravity hooks.json'
      }
    }

    buildInstalledConfig(
      config,
      (event) => getManagedCommand(scriptPath, event),
      createAntigravityManagedCommandMatcher()
    )
    writeManagedScript(scriptPath, getManagedScript())
    if (process.platform === 'win32') {
      // Why: Antigravity wraps hook commands in cmd.exe. Keeping event env
      // setup inside event-specific .cmd files avoids nested hooks.json quotes.
      for (const event of ANTIGRAVITY_EVENTS) {
        writeManagedScript(
          getWindowsWrapperScriptPath(event),
          getWindowsWrapperScript(event.eventName)
        )
      }
    }
    writeHooksJson(configPath, config)
    return this.getStatus()
  }

  async installRemote(sftp: SFTPWrapper, remoteHome: string): Promise<AgentHookInstallStatus> {
    const home = remoteHome.replace(/\/$/, '')
    const remoteConfigPath = `${home}/.gemini/config/hooks.json`
    const remoteScriptPath = `${home}/.orca/agent-hooks/antigravity-hook.sh`
    try {
      const config = await readHooksJsonRemote(sftp, remoteConfigPath)
      if (!config) {
        return {
          agent: 'antigravity',
          state: 'error',
          configPath: remoteConfigPath,
          managedHooksPresent: false,
          detail: 'Could not parse remote Antigravity hooks.json'
        }
      }

      buildInstalledConfig(
        config,
        (event) =>
          wrapPosixHookCommand(remoteScriptPath, { ORCA_ANTIGRAVITY_EVENT: event.eventName }),
        createAntigravityManagedCommandMatcher()
      )
      await writeManagedScriptRemote(sftp, remoteScriptPath, getManagedScript('posix'))
      await writeHooksJsonRemote(sftp, remoteConfigPath, config)

      return {
        agent: 'antigravity',
        state: 'installed',
        configPath: remoteConfigPath,
        managedHooksPresent: true,
        detail: null
      }
    } catch (err) {
      return {
        agent: 'antigravity',
        state: 'error',
        configPath: remoteConfigPath,
        managedHooksPresent: false,
        detail: err instanceof Error ? err.message : String(err)
      }
    }
  }

  remove(): AgentHookInstallStatus {
    const configPath = getConfigPath()
    const config = readHooksJson(configPath)
    if (!config) {
      return {
        agent: 'antigravity',
        state: 'error',
        configPath,
        managedHooksPresent: false,
        detail: 'Could not parse Antigravity hooks.json'
      }
    }

    removeInstalledConfig(config)
    writeHooksJson(configPath, config)
    return this.getStatus()
  }
}

export const antigravityHookService = new AntigravityHookService()
