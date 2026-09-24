import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { SFTPWrapper } from 'ssh2'
import type { AgentHookInstallState, AgentHookInstallStatus } from '../../shared/agent-hook-types'
import {
  buildWindowsAgentHookPostCommand,
  writeManagedScript
} from '../agent-hooks/installer-utils'
import { refreshManagedScriptIfPresent } from '../agent-hooks/managed-hook-script-refresh'
import { buildPosixAgentHookPostCommand } from '../agent-hooks/hook-post-command'
import {
  readTextFileRemote,
  writeManagedScriptRemote,
  writeTextFileRemoteAtomic
} from '../agent-hooks/installer-utils-remote'
import {
  buildWindowsHookEnvironmentGuardLines,
  buildWindowsHookStdinDrainEpilogue,
  POSIX_HOOK_STDIN_DRAIN_COMMAND,
  WINDOWS_HOOK_STDIN_DRAIN_COMMAND
} from '../agent-hooks/hook-stdin-contract'
import {
  applyJcodeManagedHooks,
  parseJcodeHooksTable,
  removeJcodeManagedHooks
} from './hook-config'
import {
  getJcodeConfigPath,
  getJcodeManagedCommand,
  getJcodeManagedScriptFileName,
  getJcodeManagedScriptPath,
  getJcodePosixManagedScriptFileName,
  getJcodeRemoteConfigPath,
  getJcodeRemoteManagedCommand,
  JCODE_HOOK_EVENTS
} from './hook-settings'

function getManagedScript(target: 'local' | 'posix' = 'local'): string {
  if (target === 'local' && process.platform === 'win32') {
    // Why a temp file rather than stdin: the shared builder posts `payload@-`, and on
    // Windows jcode's payload never reaches stdin — the pre_tool gate has already
    // drained it, and observer hooks are given a null stdin. Without this the server
    // sees no event name and normalizeJcodeEvent drops every event, so a Windows pane
    // would show no jcode status at all.
    const payloadFile = '%ORCA_JCODE_PAYLOAD_FILE%'
    return [
      '@echo off',
      // EnableDelayedExpansion so `!JCODE_HOOK_PAYLOAD!` is written verbatim: plain
      // `%VAR%` expansion re-parses the JSON's quotes and `&` as batch syntax.
      'setlocal EnableDelayedExpansion',
      // Why: endpoint file holds the live port/token; a PTY that outlives an Orca restart carries stale env, so `call` it to refresh (else PTY env).
      'if defined ORCA_AGENT_HOOK_ENDPOINT if exist "%ORCA_AGENT_HOOK_ENDPOINT%" call "%ORCA_AGENT_HOOK_ENDPOINT%" 2>nul',
      // Why the guard comes first here, unlike the POSIX script: on Windows a hook
      // that owns stdin outside an Orca pane can hang forever, because the caller
      // abandons the pipe rather than closing it (#11549). A jcode gate that exits
      // without draining costs at most jcode's own 5s pre_tool timeout, which fails
      // open; a hung hook process costs a stranded window per event.
      ...buildWindowsHookEnvironmentGuardLines(),
      // Why: inside an Orca pane, pre_tool is jcode's gate — it writes the tool input
      // to our stdin and waits for us, so drain it before the POST or a tool input
      // larger than the pipe buffer stalls the agent mid-write.
      `if "%JCODE_HOOK_EVENT%"=="pre_tool" ${WINDOWS_HOOK_STDIN_DRAIN_COMMAND}`,
      `set "ORCA_JCODE_PAYLOAD_FILE=%TEMP%\\orca-jcode-hook-%RANDOM%%RANDOM%.json"`,
      `>"${payloadFile}" echo(!JCODE_HOOK_PAYLOAD!`,
      `type "${payloadFile}" | ${buildWindowsAgentHookPostCommand('jcode', [
        '  --data-urlencode "hook_event_name=%JCODE_HOOK_EVENT%" ^',
        '  --data-urlencode "session_id=%JCODE_HOOK_SESSION_ID%" ^',
        '  --data-urlencode "cwd=%JCODE_HOOK_CWD%" ^'
      ])}`,
      `del "${payloadFile}" 2>nul`,
      'exit /b 0',
      ...buildWindowsHookStdinDrainEpilogue(),
      ''
    ].join('\r\n')
  }

  return [
    '#!/bin/sh',
    // Why: endpoint file holds the live port/token; PTYs that outlive an Orca restart carry stale env, so source it to reach the new server (else PTY env).
    // Why: silence the `.` builtin (2>/dev/null + `|| :`) so a TOCTOU race or CRLF-mangled line can't leak shell parse errors into agent transcripts (fail-open).
    'if [ -n "$ORCA_AGENT_HOOK_ENDPOINT" ] && [ -r "$ORCA_AGENT_HOOK_ENDPOINT" ]; then',
    '  . "$ORCA_AGENT_HOOK_ENDPOINT" 2>/dev/null || :',
    'fi',
    // Why before the env guard: pre_tool is jcode's gate — it writes the tool input to
    // our stdin and waits for us, so stdin must be drained before ANY exit path or a
    // tool input larger than the pipe buffer stalls the agent mid-write.
    'if [ "$JCODE_HOOK_EVENT" = pre_tool ]; then',
    `  ${POSIX_HOOK_STDIN_DRAIN_COMMAND}`,
    'fi',
    'if [ -z "$ORCA_AGENT_HOOK_PORT" ] || [ -z "$ORCA_AGENT_HOOK_TOKEN" ] || [ -z "$ORCA_PANE_KEY" ]; then',
    '  exit 0',
    'fi',
    // Why the env var rather than a stdin capture: jcode hands the hook its payload as
    // a ready JSON object (capped at 16 KB), so Orca forwards it verbatim instead of
    // hand-building JSON in shell, which is unsafe for arbitrary text.
    'payload="$JCODE_HOOK_PAYLOAD"',
    'orca_post_jcode_event() {',
    ...buildPosixAgentHookPostCommand('jcode').map((line) => `  ${line}`),
    '}',
    // Why detached on the gate: jcode reads this script's stderr to EOF before it
    // releases the tool call, so an inherited pipe would hold the tool open for as long
    // as the POST ran. Orca observes the tool live and adds no latency; the gate always
    // allows, because Orca never blocks a jcode tool.
    'if [ "$JCODE_HOOK_EVENT" = pre_tool ]; then',
    '  orca_post_jcode_event >/dev/null 2>&1 &',
    'else',
    '  orca_post_jcode_event >/dev/null 2>&1 || :',
    'fi',
    'exit 0',
    ''
  ].join('\n')
}

export class JcodeHookService {
  getStatus(): AgentHookInstallStatus {
    const configPath = getJcodeConfigPath()
    const scriptPath = getJcodeManagedScriptPath()
    const table = readJcodeHooksTable(configPath)
    if (table === null) {
      return {
        agent: 'jcode',
        state: 'error',
        configPath,
        managedHooksPresent: false,
        detail: 'Could not parse jcode config.toml [hooks] table'
      }
    }
    const scriptPresent = existsSync(scriptPath)
    const managedCommand = getJcodeManagedCommand(scriptPath)
    const missing: string[] = []
    const userOwned: string[] = []
    let managedCount = 0
    for (const event of JCODE_HOOK_EVENTS) {
      const value = table[event]
      // Why both forms: installs before the quoting fix stored the bare path, and
      // install() repoints those — reporting them user-owned would hide the repair.
      if (value === managedCommand || value === scriptPath) {
        managedCount += 1
      } else if (value === undefined) {
        missing.push(event)
      } else {
        userOwned.push(event)
      }
    }
    const managedHooksPresent = managedCount > 0 || scriptPresent
    let state: AgentHookInstallState
    let detail: string | null
    if (missing.length === 0 && userOwned.length === 0) {
      state = 'installed'
      detail = null
    } else if (managedCount === 0 && missing.length === JCODE_HOOK_EVENTS.length) {
      state = 'not_installed'
      detail = null
    } else {
      state = 'partial'
      const parts: string[] = []
      if (missing.length > 0) {
        parts.push(`Managed hook missing for events: ${missing.join(', ')}`)
      }
      if (userOwned.length > 0) {
        parts.push(`User-owned hooks kept for events: ${userOwned.join(', ')}`)
      }
      detail = parts.join('; ')
    }
    return { agent: 'jcode', state, configPath, managedHooksPresent, detail }
  }

  install(): AgentHookInstallStatus {
    const configPath = getJcodeConfigPath()
    const scriptPath = getJcodeManagedScriptPath()
    const table = readJcodeHooksTable(configPath)
    if (table === null) {
      return {
        agent: 'jcode',
        state: 'error',
        configPath,
        managedHooksPresent: false,
        detail: 'Could not parse jcode config.toml [hooks] table'
      }
    }
    writeManagedScript(scriptPath, getManagedScript())
    const content = readConfigContent(configPath)
    const edited = applyJcodeManagedHooks(
      content,
      JCODE_HOOK_EVENTS,
      getJcodeManagedCommand(scriptPath),
      getJcodeManagedScriptFileName()
    )
    writeConfigContent(configPath, edited.content)
    return this.getStatus()
  }

  // Why: jcode invokes the script path recorded in its own config.toml, so an Orca
  // upgrade that changes the script body must rewrite the file the user already has.
  async refreshManagedScripts(): Promise<void> {
    await refreshManagedScriptIfPresent(getJcodeManagedScriptPath(), getManagedScript())
  }

  async installRemote(sftp: SFTPWrapper, remoteHome: string): Promise<AgentHookInstallStatus> {
    // Why: remote-Windows is out of scope for v1 (same as Devin); assume POSIX.
    const remoteConfigPath = getJcodeRemoteConfigPath(remoteHome)
    const remoteScriptFileName = getJcodePosixManagedScriptFileName()
    const remoteScriptPath = `${remoteHome.replace(/\/+$/, '')}/.orca/agent-hooks/${remoteScriptFileName}`
    try {
      const body = await readTextFileRemote(sftp, remoteConfigPath)
      const content = body === null ? '' : body
      const parsed = parseJcodeHooksTable(content)
      if (parsed === null) {
        return {
          agent: 'jcode',
          state: 'error',
          configPath: remoteConfigPath,
          managedHooksPresent: false,
          detail: 'Could not parse remote jcode config.toml [hooks] table'
        }
      }
      // Why: write script before settings so a mid-install failure never leaves config referencing a missing script.
      await writeManagedScriptRemote(sftp, remoteScriptPath, getManagedScript('posix'))
      const edited = applyJcodeManagedHooks(
        content,
        JCODE_HOOK_EVENTS,
        getJcodeRemoteManagedCommand(remoteScriptPath),
        remoteScriptFileName
      )
      await writeTextFileRemoteAtomic(sftp, remoteConfigPath, edited.content)
      return {
        agent: 'jcode',
        state: edited.userOwnedEvents.length > 0 ? 'partial' : 'installed',
        configPath: remoteConfigPath,
        managedHooksPresent: true,
        detail:
          edited.userOwnedEvents.length > 0
            ? `User-owned hooks kept for events: ${edited.userOwnedEvents.join(', ')}`
            : null
      }
    } catch (error) {
      return {
        agent: 'jcode',
        state: 'error',
        configPath: remoteConfigPath,
        managedHooksPresent: false,
        detail: error instanceof Error ? error.message : String(error)
      }
    }
  }

  remove(): AgentHookInstallStatus {
    const configPath = getJcodeConfigPath()
    const content = readConfigContent(configPath)
    const removed = removeJcodeManagedHooks(content, getJcodeManagedScriptFileName())
    if (removed.changed) {
      writeConfigContent(configPath, removed.content)
    }
    return this.getStatus()
  }
}

export const jcodeHookService = new JcodeHookService()

function readJcodeHooksTable(configPath: string): Record<string, string> | null {
  if (!existsSync(configPath)) {
    return {}
  }
  try {
    return parseJcodeHooksTable(readFileSync(configPath, 'utf-8'))
  } catch {
    return null
  }
}

function readConfigContent(configPath: string): string {
  try {
    return existsSync(configPath) ? readFileSync(configPath, 'utf-8') : ''
  } catch {
    return ''
  }
}

function writeConfigContent(configPath: string, content: string): void {
  // Why: skip the write when the on-disk content is already identical (same
  // no-op guard as writeHooksJson) so repeated install() calls stay inert.
  if (readConfigContent(configPath) === content) {
    return
  }
  mkdirSync(dirname(configPath), { recursive: true })
  writeFileSync(configPath, content, 'utf-8')
}
