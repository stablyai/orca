import { homedir } from 'node:os'
import { join } from 'node:path'
import type { SFTPWrapper } from 'ssh2'
import type { AgentHookInstallState, AgentHookInstallStatus } from '../../shared/agent-hook-types'
import {
  buildManagedCommandDefinition,
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
import {
  buildPosixHookPayloadCapture,
  buildWindowsHookEnvironmentGuardLines,
  buildWindowsHookStdinDrainEpilogue
} from '../agent-hooks/hook-stdin-contract'

// cursor-agent's declarative hooks surface (https://cursor.com/docs/hooks); subscribe to the minimum set for spinner + turn detection.
// sessionStart/sessionEnd are NOT subscribed: they fire at process (not turn) boundaries and can race/reset the just-submitted turn's prompt cache.
const CURSOR_EVENTS = [
  'beforeSubmitPrompt',
  'stop',
  'preToolUse',
  'postToolUse',
  'postToolUseFailure',
  'beforeShellExecution',
  'beforeMCPExecution',
  'afterAgentResponse'
] as const

function getConfigPath(): string {
  return join(homedir(), '.cursor', 'hooks.json')
}

function getManagedScriptFileName(): string {
  return process.platform === 'win32' ? 'cursor-hook.cmd' : 'cursor-hook.sh'
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
      // Why: source the endpoint file so a surviving PTY reaches the current server, not the prior Orca's coordinates (see claude/hook-service.ts).
      'if defined ORCA_AGENT_HOOK_ENDPOINT if exist "%ORCA_AGENT_HOOK_ENDPOINT%" call "%ORCA_AGENT_HOOK_ENDPOINT%" 2>nul',
      ...buildWindowsHookEnvironmentGuardLines(),
      buildWindowsAgentHookPostCommand('cursor'),
      'exit /b 0',
      ...buildWindowsHookStdinDrainEpilogue(),
      ''
    ].join('\r\n')
  }

  return [
    '#!/bin/sh',
    ...buildPosixHookPayloadCapture(),
    // Why: sourcing refreshes PORT/TOKEN/ENV from the current Orca so a surviving PTY keeps reporting after a restart (see claude/hook-service.ts).
    'if [ -n "$ORCA_AGENT_HOOK_ENDPOINT" ] && [ -r "$ORCA_AGENT_HOOK_ENDPOINT" ]; then',
    '  . "$ORCA_AGENT_HOOK_ENDPOINT" 2>/dev/null || :',
    'fi',
    'if [ -z "$ORCA_AGENT_HOOK_PORT" ] || [ -z "$ORCA_AGENT_HOOK_TOKEN" ] || [ -z "$ORCA_PANE_KEY" ]; then',
    '  exit 0',
    'fi',
    // Why: worktreeId embeds a path, so hand-building JSON in shell is unsafe (quotes/newlines); post raw payload as form fields instead.
    // Why: pipe payload via curl stdin (`payload@-`), not an inline arg, so large tool output stays off the command line (EDR false positives).
    'printf \'%s\' "$payload" | curl -sS -X POST "http://127.0.0.1:${ORCA_AGENT_HOOK_PORT}/hook/cursor" \\',
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

export class CursorHookService {
  getStatus(): AgentHookInstallStatus {
    const configPath = getConfigPath()
    const scriptPath = getManagedScriptPath()
    const config = readHooksJson(configPath)
    if (!config) {
      return {
        agent: 'cursor',
        state: 'error',
        configPath,
        managedHooksPresent: false,
        detail: 'Could not parse Cursor hooks.json'
      }
    }

    const command = getManagedCommand(scriptPath)
    const missing: string[] = []
    let presentCount = 0
    for (const eventName of CURSOR_EVENTS) {
      const definitions = Array.isArray(config.hooks?.[eventName]) ? config.hooks![eventName]! : []
      // Why: Cursor puts command directly on the definition (Claude nests under `hooks`); match both shapes.
      const hasCommand = definitions.some(
        (definition) =>
          definition.command === command ||
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
    return { agent: 'cursor', state, configPath, managedHooksPresent, detail }
  }

  install(): AgentHookInstallStatus {
    const configPath = getConfigPath()
    const scriptPath = getManagedScriptPath()
    const config = readHooksJson(configPath)
    if (!config) {
      return {
        agent: 'cursor',
        state: 'error',
        configPath,
        managedHooksPresent: false,
        detail: 'Could not parse Cursor hooks.json'
      }
    }

    const command = getManagedCommand(scriptPath)
    // Why: config.hooks is undefined on a fresh file with no prior hook install.
    const nextHooks = { ...config.hooks }
    const managedEvents = new Set<string>(CURSOR_EVENTS)

    // Why: match by script filename (not exact command) so installs sweep stale entries from older builds or a different userData path.
    const isManagedCommand = createManagedCommandMatcher(getManagedScriptFileName())

    // Why: sweep managed entries from events we no longer subscribe to, else upgraded users keep firing stale hooks.
    for (const [eventName, definitions] of Object.entries(nextHooks)) {
      if (managedEvents.has(eventName)) {
        continue
      }
      if (!Array.isArray(definitions)) {
        continue
      }
      const cleaned = removeManagedCommands(definitions, isManagedCommand)
      // Also strip entries with the command at the top level (Cursor schema).
      const strippedCursorShape = cleaned.filter(
        (definition) => !isManagedCommand(definition.command as string | undefined)
      )
      if (strippedCursorShape.length === 0) {
        delete nextHooks[eventName]
      } else {
        nextHooks[eventName] = strippedCursorShape
      }
    }

    for (const eventName of CURSOR_EVENTS) {
      const current = Array.isArray(nextHooks[eventName]) ? nextHooks[eventName] : []
      // Sweep both Claude-shaped (hooks[].command) and Cursor-shaped (definition.command) variants so installs converge on one entry.
      const cleaned = removeManagedCommands(current, isManagedCommand).filter(
        (definition) => !isManagedCommand(definition.command as string | undefined)
      )
      // Why: Cursor's schema puts `command` directly on the definition (not under `hooks`); emit that shape.
      const definition: HookDefinition = buildManagedCommandDefinition(command)
      nextHooks[eventName] = [...cleaned, definition]
    }

    // Why: cursor-agent's schema requires top-level `version: 1` (https://cursor.com/docs/hooks); keep any user-pinned value.
    const nextConfig: Record<string, unknown> = { ...config, hooks: nextHooks }
    if (nextConfig.version === undefined) {
      nextConfig.version = 1
    }
    writeManagedScript(scriptPath, getManagedScript())
    writeHooksJson(configPath, nextConfig)
    return this.getStatus()
  }

  // Installs managed Cursor hooks on an SSH remote (POSIX-only). See docs/design/agent-status-over-ssh.md §8.
  async installRemote(sftp: SFTPWrapper, remoteHome: string): Promise<AgentHookInstallStatus> {
    const remoteConfigPath = `${remoteHome.replace(/\/$/, '')}/.cursor/hooks.json`
    const remoteScriptPath = `${remoteHome.replace(/\/$/, '')}/.orca/agent-hooks/cursor-hook.sh`
    try {
      const config = await readHooksJsonRemote(sftp, remoteConfigPath)
      if (!config) {
        return {
          agent: 'cursor',
          state: 'error',
          configPath: remoteConfigPath,
          managedHooksPresent: false,
          detail: 'Could not parse remote Cursor hooks.json'
        }
      }

      const command = wrapPosixHookCommand(remoteScriptPath)
      const nextHooks = { ...config.hooks }
      const isManagedCommand = createManagedCommandMatcher('cursor-hook.sh')

      for (const eventName of CURSOR_EVENTS) {
        const current = Array.isArray(nextHooks[eventName]) ? nextHooks[eventName] : []
        // Why: dual-shape sweep so repeated installs converge on a single managed entry.
        const cleaned = removeManagedCommands(current, isManagedCommand).filter(
          (definition) => !isManagedCommand(definition.command as string | undefined)
        )
        const definition: HookDefinition = buildManagedCommandDefinition(command)
        nextHooks[eventName] = [...cleaned, definition]
      }

      const nextConfig: Record<string, unknown> = { ...config, hooks: nextHooks }
      if (nextConfig.version === undefined) {
        nextConfig.version = 1
      }

      // Why: script-then-config order so a partial mid-install leaves a working script nothing points at.
      // Why: SSH remotes always use POSIX `.sh` hook paths even when Orca runs on Windows; never derive from local OS.
      await writeManagedScriptRemote(sftp, remoteScriptPath, getManagedScript('posix'))
      await writeHooksJsonRemote(sftp, remoteConfigPath, nextConfig)

      return {
        agent: 'cursor',
        state: 'installed',
        configPath: remoteConfigPath,
        managedHooksPresent: true,
        detail: null
      }
    } catch (err) {
      return {
        agent: 'cursor',
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
        agent: 'cursor',
        state: 'error',
        configPath,
        managedHooksPresent: false,
        detail: 'Could not parse Cursor hooks.json'
      }
    }

    const nextHooks = { ...config.hooks }
    const isManagedCommand = createManagedCommandMatcher(getManagedScriptFileName())
    for (const [eventName, definitions] of Object.entries(nextHooks)) {
      if (!Array.isArray(definitions)) {
        continue
      }
      const cleaned = removeManagedCommands(definitions, isManagedCommand).filter(
        (definition) => !isManagedCommand(definition.command as string | undefined)
      )
      if (cleaned.length === 0) {
        delete nextHooks[eventName]
      } else {
        nextHooks[eventName] = cleaned
      }
    }
    const nextConfig = { ...config, hooks: nextHooks }
    writeHooksJson(configPath, nextConfig)
    return this.getStatus()
  }
}

export const cursorHookService = new CursorHookService()
