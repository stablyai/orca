// Qwen Code reads Claude-shaped `hooks` from `settings.json` in its config dir
// (`QWEN_HOME ?? ~/.qwen`). Command hooks receive JSON on stdin and run through
// bash (Git Bash on Windows), so the shared POSIX curl script works everywhere.

import { homedir } from 'node:os'
import { join, posix as pathPosix } from 'node:path'
import type { SFTPWrapper } from 'ssh2'
import type { AgentHookInstallState, AgentHookInstallStatus } from '../../shared/agent-hook-types'
import {
  MANAGED_HOOK_TIMEOUT_MILLISECONDS,
  buildManagedCommandHook,
  createManagedCommandMatcher,
  getSharedManagedScriptPath,
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
import { buildPosixHookPayloadCapture } from '../agent-hooks/hook-stdin-contract'

// Why: match the CLI's `QWEN_HOME ?? ~/.qwen` resolution (qwen-code's
// getGlobalQwenDir) so hooks land in the same config dir Qwen reads at launch.
function getQwenHome(): string {
  return process.env.QWEN_HOME?.trim() || join(homedir(), '.qwen')
}

function getConfigPath(): string {
  return join(getQwenHome(), 'settings.json')
}

// Why: Qwen Code supports these Claude-compatible events (0.21+); each maps to
// a working/waiting/done transition in normalizeQwenEvent. Omit `matcher`:
// an absent matcher already matches every tool.
export const QWEN_HOOK_EVENTS = [
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'Stop',
  'StopFailure'
] as const

// Always a POSIX `.sh` script: Qwen runs command hooks through bash, which is
// Git Bash even on Windows, so a single curl-based body works on every platform.
const MANAGED_SCRIPT_FILE_NAME = 'qwen-code-hook.sh'

function getManagedScriptPath(): string {
  return getSharedManagedScriptPath(MANAGED_SCRIPT_FILE_NAME)
}

function getManagedCommand(scriptPath: string): string {
  // Forward slashes so Git Bash accepts the path on Windows.
  const posixPath = process.platform === 'win32' ? scriptPath.replaceAll('\\', '/') : scriptPath
  return wrapPosixHookCommand(posixPath)
}

function getManagedScript(): string {
  return [
    '#!/bin/sh',
    ...buildPosixHookPayloadCapture(),
    // Why: refresh PORT/TOKEN/ENV/VERSION from the current Orca install so a PTY
    // that survived an Orca restart still reaches the live listener. See
    // claude/hook-service.ts for the full rationale.
    'if [ -n "$ORCA_AGENT_HOOK_ENDPOINT" ] && [ -r "$ORCA_AGENT_HOOK_ENDPOINT" ]; then',
    '  . "$ORCA_AGENT_HOOK_ENDPOINT" 2>/dev/null || :',
    'fi',
    'if [ -z "$ORCA_AGENT_HOOK_PORT" ] || [ -z "$ORCA_AGENT_HOOK_TOKEN" ] || [ -z "$ORCA_PANE_KEY" ]; then',
    '  exit 0',
    'fi',
    // Why: worktreeId embeds a filesystem path, so hand-building JSON in POSIX
    // shell is not safe once a path contains quotes or newlines. Post the raw
    // hook payload plus metadata as form fields and let the receiver parse it.
    // Why: pipe payload to curl's stdin (`payload@-`) instead of an inline
    // `payload=$VALUE` arg, so tens-of-KB tool output stays off the curl
    // command line (EDR command-line false positives). Wire body is identical.
    'printf \'%s\' "$payload" | curl -sS -X POST "http://127.0.0.1:${ORCA_AGENT_HOOK_PORT}/hook/qwen-code" \\',
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

// Why: Qwen's command-hook `timeout` is in milliseconds (default 60000), unlike
// the seconds Kimi's TOML uses — the shared seconds constant would be a 10ms cutoff.
function buildQwenManagedCommandHook(command: string) {
  return buildManagedCommandHook(command, MANAGED_HOOK_TIMEOUT_MILLISECONDS)
}

export function applyManagedQwenHooks(config: HooksConfig, command: string): HooksConfig {
  const nextHooks = { ...config.hooks }
  const isManagedCommand = createManagedCommandMatcher(MANAGED_SCRIPT_FILE_NAME)

  for (const eventName of QWEN_HOOK_EVENTS) {
    const current = Array.isArray(nextHooks[eventName]) ? nextHooks[eventName] : []
    const cleaned = removeManagedCommands(current, isManagedCommand)
    const definition: HookDefinition = { hooks: [buildQwenManagedCommandHook(command)] }
    nextHooks[eventName] = [...cleaned, definition]
  }

  return { ...config, hooks: nextHooks }
}

export function removeManagedQwenHooks(config: HooksConfig): {
  config: HooksConfig
  changed: boolean
} {
  const nextHooks = { ...config.hooks }
  const isManagedCommand = createManagedCommandMatcher(MANAGED_SCRIPT_FILE_NAME)
  let changed = false

  for (const [eventName, definitions] of Object.entries(nextHooks)) {
    if (!Array.isArray(definitions)) {
      continue
    }
    const cleaned = removeManagedCommands(definitions, isManagedCommand)
    if (JSON.stringify(cleaned) !== JSON.stringify(definitions)) {
      changed = true
    }
    if (cleaned.length === 0) {
      delete nextHooks[eventName]
    } else {
      nextHooks[eventName] = cleaned
    }
  }

  return { config: { ...config, hooks: nextHooks }, changed }
}

export class QwenHookService {
  getStatus(): AgentHookInstallStatus {
    const configPath = getConfigPath()
    const config = readHooksJson(configPath)
    if (!config) {
      return {
        agent: 'qwen-code',
        state: 'error',
        configPath,
        managedHooksPresent: false,
        detail: 'Could not parse Qwen Code settings.json'
      }
    }

    // Why: report partial registration instead of a false installed state.
    const command = getManagedCommand(getManagedScriptPath())
    const missing: string[] = []
    let presentCount = 0
    for (const eventName of QWEN_HOOK_EVENTS) {
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
    return { agent: 'qwen-code', state, configPath, managedHooksPresent, detail }
  }

  install(): AgentHookInstallStatus {
    const configPath = getConfigPath()
    const config = readHooksJson(configPath)
    if (!config) {
      return {
        agent: 'qwen-code',
        state: 'error',
        configPath,
        managedHooksPresent: false,
        detail: 'Could not parse Qwen Code settings.json'
      }
    }

    const scriptPath = getManagedScriptPath()
    // Write the script first so settings.json never points at a missing script.
    writeManagedScript(scriptPath, getManagedScript())
    writeHooksJson(configPath, applyManagedQwenHooks(config, getManagedCommand(scriptPath)))
    return this.getStatus()
  }

  // Why: install Orca's managed Qwen hooks on a remote box over SFTP, mirroring
  // the local install. POSIX-only by design (the managed script body is
  // platform-independent and Qwen runs hooks through bash).
  async installRemote(sftp: SFTPWrapper, remoteHome: string): Promise<AgentHookInstallStatus> {
    const remoteConfigPath = pathPosix.join(remoteHome, '.qwen', 'settings.json')
    const remoteScriptPath = pathPosix.join(
      remoteHome,
      '.orca',
      'agent-hooks',
      MANAGED_SCRIPT_FILE_NAME
    )
    try {
      const config = await readHooksJsonRemote(sftp, remoteConfigPath)
      if (!config) {
        return {
          agent: 'qwen-code',
          state: 'error',
          configPath: remoteConfigPath,
          managedHooksPresent: false,
          detail: 'Could not parse remote Qwen Code settings.json'
        }
      }

      const command = wrapPosixHookCommand(remoteScriptPath)
      // Write the script first so settings.json never points at a missing script.
      await writeManagedScriptRemote(sftp, remoteScriptPath, getManagedScript())
      await writeHooksJsonRemote(sftp, remoteConfigPath, applyManagedQwenHooks(config, command))
      return {
        agent: 'qwen-code',
        state: 'installed',
        configPath: remoteConfigPath,
        managedHooksPresent: true,
        detail: null
      }
    } catch (err) {
      return {
        agent: 'qwen-code',
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
        agent: 'qwen-code',
        state: 'error',
        configPath,
        managedHooksPresent: false,
        detail: 'Could not parse Qwen Code settings.json'
      }
    }
    const { config: nextConfig, changed } = removeManagedQwenHooks(config)
    if (changed) {
      writeHooksJson(configPath, nextConfig)
    }
    return this.getStatus()
  }
}

export const qwenCodeHookService = new QwenHookService()
