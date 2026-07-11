import { join } from 'node:path'
import type { SFTPWrapper } from 'ssh2'
import type { AgentHookInstallState, AgentHookInstallStatus } from '../../shared/agent-hook-types'
import { resolveGrokHomeDir } from '../../shared/grok-session-paths'
import {
  buildManagedCommandHook,
  createManagedCommandMatcher,
  buildWindowsAgentHookPostCommand,
  getSharedManagedScriptPath,
  readHooksJson,
  removeManagedCommands,
  wrapPosixHookCommand,
  wrapWindowsHookCommand,
  writeHooksJson,
  writeManagedScript,
  type HookDefinition
} from '../agent-hooks/installer-utils'
import {
  readHooksJsonRemote,
  writeHooksJsonRemote,
  writeManagedScriptRemote
} from '../agent-hooks/installer-utils-remote'

// Why: Grok's tool-event matcher is a real regex (see Grok hooks docs). Bare
// `*` is not a valid "match all" pattern and can fail to load/match, so tool
// lifecycle hooks never fire. `.*` matches every tool name (same as Command
// Code's managed hooks).
const GROK_TOOL_EVENT_MATCHER = '.*'
const GROK_HOME_ENVELOPE_MAX_LENGTH = 4096
const WINDOWS_HOOK_PAYLOAD_FORM_LINE = '  --data-urlencode "payload@-" >nul 2>nul'

const GROK_EVENTS = [
  { eventName: 'SessionStart', definition: { hooks: [{ type: 'command', command: '' }] } },
  { eventName: 'UserPromptSubmit', definition: { hooks: [{ type: 'command', command: '' }] } },
  { eventName: 'Stop', definition: { hooks: [{ type: 'command', command: '' }] } },
  // Why: Grok can end a turn on API error without a normal Stop; without this
  // the sidebar can stick on working (same rationale as Claude StopFailure).
  { eventName: 'StopFailure', definition: { hooks: [{ type: 'command', command: '' }] } },
  { eventName: 'SessionEnd', definition: { hooks: [{ type: 'command', command: '' }] } },
  {
    eventName: 'PreToolUse',
    definition: { matcher: GROK_TOOL_EVENT_MATCHER, hooks: [{ type: 'command', command: '' }] }
  },
  {
    eventName: 'PostToolUse',
    definition: { matcher: GROK_TOOL_EVENT_MATCHER, hooks: [{ type: 'command', command: '' }] }
  },
  {
    eventName: 'PostToolUseFailure',
    definition: { matcher: GROK_TOOL_EVENT_MATCHER, hooks: [{ type: 'command', command: '' }] }
  },
  { eventName: 'Notification', definition: { hooks: [{ type: 'command', command: '' }] } }
] as const

/** Test seam: the matcher string written for Pre/Post tool lifecycle hooks. */
export function getGrokToolEventMatcherForTests(): string {
  return GROK_TOOL_EVENT_MATCHER
}

function getConfigPath(): string {
  // Why: Grok loads trusted global hook files from $GROK_HOME/hooks/*.json
  // (or ~/.grok when unset). Honor GROK_HOME so install/status match the same
  // home Grok and transcript lookup use; keep Orca entries in a dedicated file
  // so user-authored hook files stay untouched.
  return join(resolveGrokHomeDir(), 'hooks', 'orca-status.json')
}

/** Validated guest Grok home with a login-home fallback. */
function getRemoteGrokHome(remoteHome: string, remoteGrokHome?: string): string {
  // Why: SFTP paths are always POSIX — never use host path.join here.
  const home = remoteHome.replace(/\/+$/, '') || remoteHome
  const candidate = remoteGrokHome?.trim()
  if (
    candidate &&
    candidate === remoteGrokHome &&
    candidate.startsWith('/') &&
    !candidate.includes('\\') &&
    candidate.length <= GROK_HOME_ENVELOPE_MAX_LENGTH &&
    !hasControlCharacter(candidate)
  ) {
    return candidate.replace(/\/+$/, '') || '/'
  }
  return `${home}/.grok`
}

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0)
    return code <= 0x1f || code === 0x7f
  })
}

const WINDOWS_GROK_HOOK_POST_COMMAND = buildWindowsAgentHookPostCommand('grok').replace(
  WINDOWS_HOOK_PAYLOAD_FORM_LINE,
  `  --data-urlencode "grokHome=%ORCA_GROK_HOME%" ^\r\n${WINDOWS_HOOK_PAYLOAD_FORM_LINE}`
)

function getManagedScriptFileName(): string {
  return process.platform === 'win32' ? 'grok-hook.cmd' : 'grok-hook.sh'
}

function getManagedScriptPath(): string {
  return getSharedManagedScriptPath(getManagedScriptFileName())
}

function getManagedCommand(scriptPath: string): string {
  return process.platform === 'win32'
    ? wrapWindowsHookCommand(scriptPath)
    : wrapPosixHookCommand(scriptPath)
}

function getManagedScript(target: 'local' | 'posix' = 'local'): string {
  if (target === 'local' && process.platform === 'win32') {
    return [
      '@echo off',
      'setlocal',
      'if defined ORCA_AGENT_HOOK_ENDPOINT if exist "%ORCA_AGENT_HOOK_ENDPOINT%" call "%ORCA_AGENT_HOOK_ENDPOINT%" 2>nul',
      'if "%ORCA_AGENT_HOOK_PORT%"=="" exit /b 0',
      'if "%ORCA_AGENT_HOOK_TOKEN%"=="" exit /b 0',
      'if "%ORCA_PANE_KEY%"=="" exit /b 0',
      'set "ORCA_GROK_HOME=%GROK_HOME%"',
      `if not "%GROK_HOME:~${GROK_HOME_ENVELOPE_MAX_LENGTH},1%"=="" set "ORCA_GROK_HOME="`,
      // Why: a trailing backslash escapes curl's closing argv quote on Windows,
      // merging the payload option into grokHome and dropping the hook body.
      'if "%ORCA_GROK_HOME:~-1%"=="\\" set "ORCA_GROK_HOME=%ORCA_GROK_HOME%."',
      WINDOWS_GROK_HOOK_POST_COMMAND,
      'exit /b 0',
      ''
    ].join('\r\n')
  }

  return [
    '#!/bin/sh',
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
    'grok_home=',
    `if [ -n "\${GROK_HOME:-}" ] && [ "\${#GROK_HOME}" -le ${GROK_HOME_ENVELOPE_MAX_LENGTH} ]; then`,
    '  grok_home=$GROK_HOME',
    'fi',
    // Timeout caps best-effort hook posts if the local listener stalls.
    // Why: pipe payload to curl's stdin (`payload@-`) instead of an inline
    // `payload=$VALUE` arg, so tens-of-KB tool output stays off the curl
    // command line (EDR command-line false positives). Wire body is identical.
    'printf \'%s\' "$payload" | curl -sS -X POST "http://127.0.0.1:${ORCA_AGENT_HOOK_PORT}/hook/grok" \\',
    '  --connect-timeout 0.5 --max-time 1.5 \\',
    '  -H "Content-Type: application/x-www-form-urlencoded" \\',
    '  -H "X-Orca-Agent-Hook-Token: ${ORCA_AGENT_HOOK_TOKEN}" \\',
    '  --data-urlencode "paneKey=${ORCA_PANE_KEY}" \\',
    '  --data-urlencode "tabId=${ORCA_TAB_ID}" \\',
    '  --data-urlencode "launchToken=${ORCA_AGENT_LAUNCH_TOKEN}" \\',
    '  --data-urlencode "worktreeId=${ORCA_WORKTREE_ID}" \\',
    '  --data-urlencode "env=${ORCA_AGENT_HOOK_ENV}" \\',
    '  --data-urlencode "version=${ORCA_AGENT_HOOK_VERSION}" \\',
    '  --data-urlencode "grokHome=${grok_home}" \\',
    '  --data-urlencode "payload@-" >/dev/null 2>&1 || true',
    'exit 0',
    ''
  ].join('\n')
}

function buildInstalledConfig(
  config: NonNullable<ReturnType<typeof readHooksJson>>,
  command: string,
  scriptFileName: string
): void {
  const nextHooks = { ...config.hooks }
  const isManagedCommand = createManagedCommandMatcher(scriptFileName)
  const managedEvents = new Set<string>(GROK_EVENTS.map((event) => event.eventName))

  // Why: Orca owns only grok-hook.* entries. Sweep stale managed commands out
  // of retired events while preserving any user-authored hooks in this file.
  for (const [eventName, definitions] of Object.entries(nextHooks)) {
    if (managedEvents.has(eventName) || !Array.isArray(definitions)) {
      continue
    }
    const cleaned = removeManagedCommands(definitions, isManagedCommand)
    if (cleaned.length === 0) {
      delete nextHooks[eventName]
    } else {
      nextHooks[eventName] = cleaned
    }
  }

  for (const event of GROK_EVENTS) {
    const current = Array.isArray(nextHooks[event.eventName]) ? nextHooks[event.eventName] : []
    const cleaned = removeManagedCommands(current, isManagedCommand)
    const definition: HookDefinition = {
      ...event.definition,
      hooks: [buildManagedCommandHook(command)]
    }
    nextHooks[event.eventName] = [...cleaned, definition]
  }

  config.hooks = nextHooks
}

export class GrokHookService {
  getStatus(): AgentHookInstallStatus {
    const configPath = getConfigPath()
    const scriptPath = getManagedScriptPath()
    const config = readHooksJson(configPath)
    if (!config) {
      return {
        agent: 'grok',
        state: 'error',
        configPath,
        managedHooksPresent: false,
        detail: 'Could not parse Grok hook config'
      }
    }

    const command = getManagedCommand(scriptPath)
    const missing: string[] = []
    let presentCount = 0
    for (const event of GROK_EVENTS) {
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
    return { agent: 'grok', state, configPath, managedHooksPresent, detail }
  }

  install(): AgentHookInstallStatus {
    const configPath = getConfigPath()
    const scriptPath = getManagedScriptPath()
    const config = readHooksJson(configPath)
    if (!config) {
      return {
        agent: 'grok',
        state: 'error',
        configPath,
        managedHooksPresent: false,
        detail: 'Could not parse Grok hook config'
      }
    }

    buildInstalledConfig(config, getManagedCommand(scriptPath), getManagedScriptFileName())
    writeManagedScript(scriptPath, getManagedScript())
    writeHooksJson(configPath, config)
    return this.getStatus()
  }

  async installRemote(
    sftp: SFTPWrapper,
    remoteHome: string,
    remoteGrokHome?: string
  ): Promise<AgentHookInstallStatus> {
    const home = remoteHome.replace(/\/$/, '')
    // Why: only a guest-resolved path can describe remote Grok; never apply the
    // host process's GROK_HOME to SFTP paths.
    const remoteConfigPath = `${getRemoteGrokHome(home, remoteGrokHome)}/hooks/orca-status.json`
    const remoteScriptPath = `${home}/.orca/agent-hooks/grok-hook.sh`
    try {
      const config = await readHooksJsonRemote(sftp, remoteConfigPath)
      if (!config) {
        return {
          agent: 'grok',
          state: 'error',
          configPath: remoteConfigPath,
          managedHooksPresent: false,
          detail: 'Could not parse remote Grok hook config'
        }
      }

      buildInstalledConfig(config, wrapPosixHookCommand(remoteScriptPath), 'grok-hook.sh')
      await writeManagedScriptRemote(sftp, remoteScriptPath, getManagedScript('posix'))
      await writeHooksJsonRemote(sftp, remoteConfigPath, config)

      return {
        agent: 'grok',
        state: 'installed',
        configPath: remoteConfigPath,
        managedHooksPresent: true,
        detail: null
      }
    } catch (err) {
      return {
        agent: 'grok',
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
        agent: 'grok',
        state: 'error',
        configPath,
        managedHooksPresent: false,
        detail: 'Could not parse Grok hook config'
      }
    }

    const nextHooks = { ...config.hooks }
    const isManagedCommand = createManagedCommandMatcher(getManagedScriptFileName())
    for (const [eventName, definitions] of Object.entries(nextHooks)) {
      if (!Array.isArray(definitions)) {
        continue
      }
      const cleaned = removeManagedCommands(definitions, isManagedCommand)
      if (cleaned.length === 0) {
        delete nextHooks[eventName]
      } else {
        nextHooks[eventName] = cleaned
      }
    }

    config.hooks = nextHooks
    writeHooksJson(configPath, config)
    return this.getStatus()
  }
}

export const grokHookService = new GrokHookService()
