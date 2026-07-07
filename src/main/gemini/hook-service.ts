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
  buildPosixManagedHookScript,
  buildWindowsEndpointLoadLine,
  buildWindowsEndpointSubroutineLines
} from '../agent-hooks/managed-hook-script'
import {
  readHooksJsonRemote,
  writeHooksJsonRemote,
  writeManagedScriptRemote
} from '../agent-hooks/installer-utils-remote'

// Why: Gemini CLI fires `BeforeAgent` when a turn starts and `AfterAgent` when
// it completes. `AfterTool` marks the resumption of model work after a tool
// call, which maps back to `working`. Gemini has no permission-prompt hook
// (approvals flow through inline UI), so Orca cannot surface a waiting state
// for Gemini — that is an upstream limitation, not an Orca bug.
//
// Gemini's native pre-tool event is BeforeTool, not Claude/Codex's PreToolUse.
// Keep installing the pre-tool status hook, but sweep stale PreToolUse entries
// below so current Gemini CLI no longer warns about an invalid event bucket.
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
      // Why: Gemini expects valid JSON on stdout even when the hook has nothing
      // to return. Emit `{}` first so the agent never stalls parsing our
      // output, even if the env-var guards below cause an early exit.
      'echo {}',
      // Why: see claude/hook-service.ts for rationale. The endpoint file holds
      // the live port/token for this Orca install; reloading it here lets a
      // surviving PTY reach the current server even though its env points at
      // the prior Orca's coordinates. Parsed, never executed.
      buildWindowsEndpointLoadLine(),
      'if "%ORCA_AGENT_HOOK_PORT%"=="" exit /b 0',
      'if "%ORCA_AGENT_HOOK_TOKEN%"=="" exit /b 0',
      'if "%ORCA_PANE_KEY%"=="" exit /b 0',
      buildWindowsAgentHookPostCommand('gemini'),
      'exit /b 0',
      ...buildWindowsEndpointSubroutineLines(),
      ''
    ].join('\r\n')
  }

  return buildPosixManagedHookScript({
    source: 'gemini',
    // Why: Gemini expects valid JSON on stdout even when the hook has nothing
    // to return. Emit `{}` first so the agent never stalls parsing our output,
    // even if the env-var guards below cause an early exit.
    preludeLines: ['printf "{}\\n"']
  })
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

    // Why: match by script filename (not exact command string) so a fresh
    // install sweeps stale entries left by older builds or a different
    // Electron userData path (dev vs. prod). Without this, repeated installs
    // accumulate duplicate hook entries pointing at defunct scripts.
    const isManagedCommand = createManagedCommandMatcher(getManagedScriptFileName())

    const managedEvents = new Set<string>(GEMINI_EVENTS)

    // Why: when Orca stops subscribing to an event, install() must sweep the
    // old managed entry out of any leftover event bucket. Otherwise a stale
    // hook such as PreToolUse survives forever in ~/.gemini/settings.json and
    // continues firing even though the current build no longer wants it.
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

  // Why: install Orca's managed Gemini hooks on the remote box. Mirrors
  // ClaudeHookService.installRemote — POSIX-only, uses the same SFTP-backed
  // primitives, and lays down the same script body the local install
  // generates so a remote-side Gemini CLI behaves identically. See
  // docs/design/agent-status-over-ssh.md §8.
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

      // Why: remote installs must sweep legacy managed event buckets too.
      // Otherwise stale PreToolUse entries keep warning in SSH Gemini sessions.
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

      // Why: write the script first so an interrupted install never leaves
      // settings.json pointing at a missing script. See ClaudeHookService.
      // Why: SSH remotes use POSIX `.sh` hook paths even when Orca itself is
      // running on Windows; never derive remote script syntax from local OS.
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
    // Why: same broad matcher as install(), so remove() also cleans up stale
    // entries from older builds even if the current scriptPath has moved.
    const isManagedCommand = createManagedCommandMatcher(getManagedScriptFileName())
    for (const [eventName, definitions] of Object.entries(nextHooks)) {
      // Why: a malformed settings.json entry (non-array value for an event
      // name) would make removeManagedCommands throw via definitions.flatMap.
      // Skip — remove() must fail open so a broken user config never blocks
      // uninstall.
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
