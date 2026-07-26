import { homedir } from 'node:os'
import { join } from 'node:path'
import type { SFTPWrapper } from 'ssh2'
import type { AgentHookInstallState, AgentHookInstallStatus } from '../../shared/agent-hook-types'
import {
  buildManagedCommandHook,
  createManagedCommandMatcher,
  buildWindowsAgentHookPostCommand,
  getSharedManagedScriptPath,
  MANAGED_HOOK_TIMEOUT_MILLISECONDS,
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
import {
  buildPosixHookPayloadCapture,
  buildWindowsHookEnvironmentGuardLines,
  buildWindowsHookStdinDrainEpilogue
} from '../agent-hooks/hook-stdin-contract'

// Why: Gemini has no permission-prompt hook (approvals are inline UI), so Orca can't show a waiting state — upstream limitation.
// Why: Gemini's pre-tool event is BeforeTool, not Claude/Codex's PreToolUse; sweep stale PreToolUse entries below.
const GEMINI_EVENTS = ['BeforeAgent', 'AfterAgent', 'AfterTool', 'BeforeTool'] as const

function getConfigPath(): string {
  return join(homedir(), '.gemini', 'settings.json')
}

function getManagedScriptFileName(): string {
  return process.platform === 'win32' ? 'gemini-hook.cmd' : 'gemini-hook.sh'
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
      // Why: emit `{}` first so Gemini never stalls parsing stdout, even if the guards below exit early.
      'echo {}',
      // Why: source the endpoint file so a surviving PTY reaches the current server. See claude/hook-service.ts.
      'if defined ORCA_AGENT_HOOK_ENDPOINT if exist "%ORCA_AGENT_HOOK_ENDPOINT%" call "%ORCA_AGENT_HOOK_ENDPOINT%" 2>nul',
      ...buildWindowsHookEnvironmentGuardLines(),
      buildWindowsAgentHookPostCommand('gemini'),
      'exit /b 0',
      ...buildWindowsHookStdinDrainEpilogue(),
      ''
    ].join('\r\n')
  }

  return [
    '#!/bin/sh',
    // Why: emit `{}` first so Gemini never stalls parsing stdout, even if the guards below exit early.
    'printf "{}\\n"',
    ...buildPosixHookPayloadCapture(),
    // Why: source refreshes endpoint coords so a PTY surviving an Orca restart keeps reporting. See claude/hook-service.ts.
    'if [ -n "$ORCA_AGENT_HOOK_ENDPOINT" ] && [ -r "$ORCA_AGENT_HOOK_ENDPOINT" ]; then',
    '  . "$ORCA_AGENT_HOOK_ENDPOINT" 2>/dev/null || :',
    'fi',
    'if [ -z "$ORCA_AGENT_HOOK_PORT" ] || [ -z "$ORCA_AGENT_HOOK_TOKEN" ] || [ -z "$ORCA_PANE_KEY" ]; then',
    '  exit 0',
    'fi',
    // Why: worktreeId embeds a path, so post form fields, not hand-built JSON that breaks on quotes/newlines.
    // Why: pipe payload via curl stdin (`payload@-`) so large tool output stays off the command line (EDR false positives).
    'printf \'%s\' "$payload" | curl -sS -X POST "http://127.0.0.1:${ORCA_AGENT_HOOK_PORT}/hook/gemini" \\',
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

export class GeminiHookService {
  getStatus(): AgentHookInstallStatus {
    const configPath = getConfigPath()
    const scriptPath = getManagedScriptPath()
    const config = readHooksJson(configPath)
    if (!config) {
      return {
        agent: 'gemini',
        state: 'error',
        configPath,
        managedHooksPresent: false,
        detail: 'Could not parse Gemini settings.json'
      }
    }

    const command = getManagedCommand(scriptPath)
    const missing: string[] = []
    let presentCount = 0
    for (const eventName of GEMINI_EVENTS) {
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
    return { agent: 'gemini', state, configPath, managedHooksPresent, detail }
  }

  install(): AgentHookInstallStatus {
    const configPath = getConfigPath()
    const scriptPath = getManagedScriptPath()
    const config = readHooksJson(configPath)
    if (!config) {
      return {
        agent: 'gemini',
        state: 'error',
        configPath,
        managedHooksPresent: false,
        detail: 'Could not parse Gemini settings.json'
      }
    }

    const command = getManagedCommand(scriptPath)
    const nextHooks = { ...config.hooks }

    // Why: match by filename not exact command, so installs sweep stale entries instead of duplicating them.
    const isManagedCommand = createManagedCommandMatcher(getManagedScriptFileName())

    const managedEvents = new Set<string>(GEMINI_EVENTS)

    // Why: sweep managed entries from dropped event buckets so stale hooks (e.g. PreToolUse) don't keep firing.
    for (const [eventName, definitions] of Object.entries(nextHooks)) {
      if (managedEvents.has(eventName)) {
        continue
      }
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

    for (const eventName of GEMINI_EVENTS) {
      const current = Array.isArray(nextHooks[eventName]) ? nextHooks[eventName] : []
      const cleaned = removeManagedCommands(current, isManagedCommand)
      const definition: HookDefinition = {
        // Why: Gemini's hook `timeout` unit is milliseconds, unlike Claude/Codex.
        hooks: [buildManagedCommandHook(command, MANAGED_HOOK_TIMEOUT_MILLISECONDS)]
      }
      nextHooks[eventName] = [...cleaned, definition]
    }

    config.hooks = nextHooks
    writeManagedScript(scriptPath, getManagedScript())
    writeHooksJson(configPath, config)
    return this.getStatus()
  }

  // POSIX-only remote install mirroring ClaudeHookService.installRemote. See docs/design/agent-status-over-ssh.md §8.
  async installRemote(sftp: SFTPWrapper, remoteHome: string): Promise<AgentHookInstallStatus> {
    const remoteConfigPath = `${remoteHome.replace(/\/$/, '')}/.gemini/settings.json`
    const remoteScriptPath = `${remoteHome.replace(/\/$/, '')}/.orca/agent-hooks/gemini-hook.sh`
    try {
      const config = await readHooksJsonRemote(sftp, remoteConfigPath)
      if (!config) {
        return {
          agent: 'gemini',
          state: 'error',
          configPath: remoteConfigPath,
          managedHooksPresent: false,
          detail: 'Could not parse remote Gemini settings.json'
        }
      }

      const command = wrapPosixHookCommand(remoteScriptPath)
      const nextHooks = { ...config.hooks }
      const isManagedCommand = createManagedCommandMatcher('gemini-hook.sh')
      const managedEvents = new Set<string>(GEMINI_EVENTS)

      // Why: sweep legacy managed event buckets so stale PreToolUse stops warning in SSH Gemini sessions.
      for (const [eventName, definitions] of Object.entries(nextHooks)) {
        if (managedEvents.has(eventName)) {
          continue
        }
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

      for (const eventName of GEMINI_EVENTS) {
        const current = Array.isArray(nextHooks[eventName]) ? nextHooks[eventName] : []
        const cleaned = removeManagedCommands(current, isManagedCommand)
        const definition: HookDefinition = {
          // Why: Gemini's hook `timeout` unit is milliseconds, unlike Claude/Codex.
          hooks: [buildManagedCommandHook(command, MANAGED_HOOK_TIMEOUT_MILLISECONDS)]
        }
        nextHooks[eventName] = [...cleaned, definition]
      }
      config.hooks = nextHooks

      // Why: write the script before settings.json so an interrupted install never points at a missing script.
      // Why: SSH remotes always use POSIX `.sh` paths even when Orca runs on Windows.
      await writeManagedScriptRemote(sftp, remoteScriptPath, getManagedScript('posix'))
      await writeHooksJsonRemote(sftp, remoteConfigPath, config)

      return {
        agent: 'gemini',
        state: 'installed',
        configPath: remoteConfigPath,
        managedHooksPresent: true,
        detail: null
      }
    } catch (err) {
      return {
        agent: 'gemini',
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
        agent: 'gemini',
        state: 'error',
        configPath,
        managedHooksPresent: false,
        detail: 'Could not parse Gemini settings.json'
      }
    }

    const nextHooks = { ...config.hooks }
    // Why: match by filename so remove() sweeps stale entries even after the script path moved.
    const isManagedCommand = createManagedCommandMatcher(getManagedScriptFileName())
    for (const [eventName, definitions] of Object.entries(nextHooks)) {
      // Why: fail open on malformed (non-array) entries so a broken user config never blocks uninstall.
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

export const geminiHookService = new GeminiHookService()
