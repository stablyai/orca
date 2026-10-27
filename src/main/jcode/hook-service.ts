import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { SFTPWrapper } from 'ssh2'
import type { AgentHookInstallState, AgentHookInstallStatus } from '../../shared/agent-hook-types'
import {
  buildWindowsAgentHookPostCommand,
  createManagedCommandMatcher,
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
    // Windows stdin is drained or null; post JCODE_HOOK_PAYLOAD through a temp file instead.
    const payloadFile = '%ORCA_JCODE_PAYLOAD_FILE%'
    return [
      '@echo off',
      // Delayed expansion keeps JSON quotes and & out of cmd parsing.
      'setlocal EnableDelayedExpansion',
      // Refresh endpoint credentials for PTYs surviving an Orca restart.
      'if defined ORCA_AGENT_HOOK_ENDPOINT if exist "%ORCA_AGENT_HOOK_ENDPOINT%" call "%ORCA_AGENT_HOOK_ENDPOINT%" 2>nul',
      // Guard before reading: abandoned Windows stdin can hang forever outside Orca (#11549).
      ...buildWindowsHookEnvironmentGuardLines(),
      // Drain pre_tool input before POST so jcode cannot block writing a payload larger than the pipe.
      `if "%JCODE_HOOK_EVENT%"=="pre_tool" ${WINDOWS_HOOK_STDIN_DRAIN_COMMAND}`,
      `set "ORCA_JCODE_PAYLOAD_FILE=%TEMP%\\orca-jcode-hook-%RANDOM%%RANDOM%.json"`,
      `>"${payloadFile}" echo(!JCODE_HOOK_PAYLOAD!`,
      // Input redirection avoids spawning cmd's extra pipeline shells on every event.
      `<"${payloadFile}" ${buildWindowsAgentHookPostCommand('jcode', [
        '  --data-urlencode "hook_event_name=%JCODE_HOOK_EVENT%" ^',
        '  --data-urlencode "session_id=%JCODE_HOOK_SESSION_ID%" ^',
        '  --data-urlencode "cwd=%JCODE_HOOK_CWD%" ^'
      ])}`,
      `del "${payloadFile}" 2>nul`,
      'exit /b 0',
      ''
    ].join('\r\n')
  }

  return [
    '#!/bin/sh',
    // Refresh surviving PTYs; silence sourcing failures from endpoint races or CRLF damage.
    'if [ -n "$ORCA_AGENT_HOOK_ENDPOINT" ] && [ -r "$ORCA_AGENT_HOOK_ENDPOINT" ]; then',
    '  . "$ORCA_AGENT_HOOK_ENDPOINT" 2>/dev/null || :',
    'fi',
    // Drain gated input before every exit path so jcode cannot block mid-write.
    'if [ "$JCODE_HOOK_EVENT" = pre_tool ]; then',
    `  ${POSIX_HOOK_STDIN_DRAIN_COMMAND}`,
    'fi',
    'if [ -z "$ORCA_AGENT_HOOK_PORT" ] || [ -z "$ORCA_AGENT_HOOK_TOKEN" ] || [ -z "$ORCA_PANE_KEY" ]; then',
    '  exit 0',
    'fi',
    // Forward jcode's JSON payload verbatim; rebuilding arbitrary text in shell is unsafe.
    'payload="$JCODE_HOOK_PAYLOAD"',
    'orca_post_jcode_event() {',
    ...buildPosixAgentHookPostCommand('jcode').map((line) => `  ${line}`),
    '}',
    // Detach the observer POST: jcode waits for gate stderr EOF before releasing the tool.
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
    const isManaged = createManagedCommandMatcher(getJcodeManagedScriptFileName())
    const missing: string[] = []
    const outdated: string[] = []
    const userOwned: string[] = []
    let managedCount = 0
    for (const event of JCODE_HOOK_EVENTS) {
      const value = table[event]
      if (value === managedCommand) {
        managedCount += 1
      } else if (isManaged(value)) {
        outdated.push(event)
      } else if (value === undefined) {
        missing.push(event)
      } else {
        userOwned.push(event)
      }
    }
    const hasManagedEntries = managedCount > 0 || outdated.length > 0
    const managedHooksPresent = hasManagedEntries || scriptPresent
    let state: AgentHookInstallState
    let detail: string | null
    if (managedCount === JCODE_HOOK_EVENTS.length && scriptPresent) {
      state = 'installed'
      detail = null
    } else if (!hasManagedEntries && missing.length === JCODE_HOOK_EVENTS.length) {
      state = 'not_installed'
      detail = null
    } else {
      state = 'partial'
      const parts: string[] = []
      if (hasManagedEntries && !scriptPresent) {
        parts.push('Managed hook script missing')
      }
      if (outdated.length > 0) {
        parts.push(`Managed hook command outdated for events: ${outdated.join(', ')}`)
      }
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

  // jcode invokes the configured file, so upgrades must refresh existing scripts.
  async refreshManagedScripts(): Promise<void> {
    await refreshManagedScriptIfPresent(getJcodeManagedScriptPath(), getManagedScript())
  }

  async installRemote(sftp: SFTPWrapper, remoteHome: string): Promise<AgentHookInstallStatus> {
    // Remote hook execution assumes POSIX; Windows remotes are unsupported.
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
      // Publish the script before config so interrupted installs cannot reference a missing file.
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
  if (readConfigContent(configPath) === content) {
    return
  }
  mkdirSync(dirname(configPath), { recursive: true })
  writeFileSync(configPath, content, 'utf-8')
}
