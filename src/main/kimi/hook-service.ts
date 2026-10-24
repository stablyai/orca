import {
  copyFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, posix as pathPosix } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { SFTPWrapper } from 'ssh2'
import type { AgentHookInstallState, AgentHookInstallStatus } from '../../shared/agent-hook-types'
import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'
import {
  buildWindowsAgentHookCurlPostCommand,
  createManagedCommandMatcher,
  getSharedManagedScriptPath,
  wrapPosixHookCommand,
  writeManagedScript
} from '../agent-hooks/installer-utils'
import { wrapWindowsBatchHookCommand } from '../agent-hooks/windows-direct-cmd-hook-command'
import { refreshManagedScriptIfPresent } from '../agent-hooks/managed-hook-script-refresh'
import {
  readTextFileRemote,
  writeManagedScriptRemote,
  writeTextFileRemoteAtomic
} from '../agent-hooks/installer-utils-remote'
import {
  buildPosixHookPayloadCapture,
  buildPosixHookSpoolLines,
  buildWindowsHookEnvironmentGuardLines,
  buildWindowsHookStdinDrainEpilogue
} from '../agent-hooks/hook-stdin-contract'
import {
  applyManagedKimiHooks,
  KIMI_HOOK_EVENTS,
  readManagedKimiHookEvents,
  removeManagedKimiHooks
} from './kimi-hook-config-toml'

// Honor the same KIMI_CODE_HOME as the CLI and session scanner.
function getKimiHome(): string {
  return process.env.KIMI_CODE_HOME?.trim() || join(homedir(), '.kimi-code')
}

function getConfigPath(): string {
  return join(getKimiHome(), 'config.toml')
}

// Kimi uses cmd.exe on Windows and sh elsewhere; Git Bash is only for its Shell tool.
const POSIX_SCRIPT_FILE_NAME = 'kimi-hook.sh'
const WINDOWS_SCRIPT_FILE_NAME = 'kimi-hook.cmd'

// Share ownership across status/install/remove/orphan recovery, including legacy .sh entries on Windows.
const isManagedKimiCommand = createManagedCommandMatcher(POSIX_SCRIPT_FILE_NAME)

function getManagedScriptPath(): string {
  return getSharedManagedScriptPath(
    process.platform === 'win32' ? WINDOWS_SCRIPT_FILE_NAME : POSIX_SCRIPT_FILE_NAME
  )
}

export function getManagedCommand(scriptPath: string): string {
  // Forward slashes preserve ownership matching against still-escaped TOML literals.
  return process.platform === 'win32'
    ? wrapWindowsBatchHookCommand(scriptPath)
    : wrapPosixHookCommand(scriptPath)
}

function getManagedScript(target: 'local' | 'posix' = 'local'): string {
  if (target === 'local' && process.platform === 'win32') {
    return [
      '@echo off',
      'setlocal',
      // Refresh endpoint credentials for PTYs surviving an Orca restart.
      'if defined ORCA_AGENT_HOOK_ENDPOINT if exist "%ORCA_AGENT_HOOK_ENDPOINT%" call "%ORCA_AGENT_HOOK_ENDPOINT%" 2>nul',
      ...buildWindowsHookEnvironmentGuardLines(),
      buildWindowsAgentHookCurlPostCommand('kimi'),
      'exit /b 0',
      ...buildWindowsHookStdinDrainEpilogue(),
      ''
    ].join('\r\n')
  }
  return [
    '#!/bin/sh',
    ...buildPosixHookPayloadCapture(),
    ...buildPosixHookSpoolLines('kimi'),
    // Refresh endpoint credentials for PTYs surviving an Orca restart.
    'if [ -n "$ORCA_AGENT_HOOK_ENDPOINT" ] && [ -r "$ORCA_AGENT_HOOK_ENDPOINT" ]; then',
    '  . "$ORCA_AGENT_HOOK_ENDPOINT" 2>/dev/null || :',
    'fi',
    'if [ -z "$ORCA_AGENT_HOOK_PORT" ] || [ -z "$ORCA_AGENT_HOOK_TOKEN" ] || [ -z "$ORCA_PANE_KEY" ]; then',
    '  spool_hook_event',
    '  exit 0',
    'fi',
    // Form fields preserve arbitrary path text; stdin keeps large payloads off curl's command line for EDR.
    'printf \'%s\' "$payload" | curl -sS -X POST "http://127.0.0.1:${ORCA_AGENT_HOOK_PORT}/hook/kimi" \\',
    '  --connect-timeout 0.5 --max-time 1.5 \\',
    '  -H "Content-Type: application/x-www-form-urlencoded" \\',
    '  -H "X-Orca-Agent-Hook-Token: ${ORCA_AGENT_HOOK_TOKEN}" \\',
    '  --data-urlencode "paneKey=${ORCA_PANE_KEY}" \\',
    '  --data-urlencode "tabId=${ORCA_TAB_ID}" \\',
    '  --data-urlencode "launchToken=${ORCA_AGENT_LAUNCH_TOKEN}" \\',
    '  --data-urlencode "worktreeId=${ORCA_WORKTREE_ID}" \\',
    '  --data-urlencode "env=${ORCA_AGENT_HOOK_ENV}" \\',
    '  --data-urlencode "version=${ORCA_AGENT_HOOK_VERSION}" \\',
    '  --data-urlencode "payload@-" >/dev/null 2>&1 || spool_hook_event',
    'exit 0',
    ''
  ].join('\n')
}

/** Empty means missing; null means unreadable and must surface an error. */
function readConfigToml(configPath: string): string | null {
  if (!existsSync(configPath)) {
    return ''
  }
  try {
    return readFileSync(configPath, 'utf-8')
  } catch {
    return null
  }
}

// Atomic replacement protects interrupted writes; a rolling backup permits recovery.
function writeConfigToml(configPath: string, text: string): void {
  const dir = dirname(configPath)
  mkdirSync(dir, { recursive: true })
  // Atomic rename gives the config the temp file's mode.
  let mode = 0o600
  if (existsSync(configPath)) {
    try {
      if (readFileSync(configPath, 'utf-8') === text) {
        return
      }
    } catch {}
    try {
      mode = statSync(configPath).mode & 0o777
    } catch (error) {
      // Concurrent deletion leaves no mode to preserve; other errors must propagate.
      if (!isDefinitiveAbsence(error)) {
        throw error
      }
    }
  }
  const tmpPath = join(dir, `.${Date.now()}-${randomUUID()}.tmp`)
  try {
    writeFileSync(tmpPath, text, { encoding: 'utf-8', mode: 0o600 })
    chmodSync(tmpPath, mode)
    if (existsSync(configPath)) {
      copyFileSync(configPath, `${configPath}.bak`)
    }
    renameSync(tmpPath, configPath)
  } finally {
    if (existsSync(tmpPath)) {
      try {
        unlinkSync(tmpPath)
      } catch {
        // best effort
      }
    }
  }
}

function buildStatus(present: Set<string>, configPath: string): AgentHookInstallStatus {
  const missing = KIMI_HOOK_EVENTS.filter((event) => !present.has(event))
  let state: AgentHookInstallState
  let detail: string | null
  if (missing.length === 0) {
    state = 'installed'
    detail = null
  } else if (present.size === 0) {
    state = 'not_installed'
    detail = null
  } else {
    state = 'partial'
    detail = `Managed hook missing for events: ${missing.join(', ')}`
  }
  return { agent: 'kimi', state, configPath, managedHooksPresent: present.size > 0, detail }
}

export class KimiHookService {
  async refreshManagedScripts(): Promise<void> {
    await refreshManagedScriptIfPresent(getManagedScriptPath(), getManagedScript())
  }

  getStatus(): AgentHookInstallStatus {
    const configPath = getConfigPath()
    const text = readConfigToml(configPath)
    if (text === null) {
      return {
        agent: 'kimi',
        state: 'error',
        configPath,
        managedHooksPresent: false,
        detail: 'Could not read Kimi config.toml'
      }
    }
    return buildStatus(readManagedKimiHookEvents(text, isManagedKimiCommand), configPath)
  }

  install(): AgentHookInstallStatus {
    const configPath = getConfigPath()
    const text = readConfigToml(configPath)
    if (text === null) {
      return {
        agent: 'kimi',
        state: 'error',
        configPath,
        managedHooksPresent: false,
        detail: 'Could not read Kimi config.toml'
      }
    }
    const scriptPath = getManagedScriptPath()
    const command = getManagedCommand(scriptPath)
    // Write the script first so config.toml never points at a missing script.
    writeManagedScript(scriptPath, getManagedScript())
    writeConfigToml(configPath, applyManagedKimiHooks(text, command, isManagedKimiCommand))
    return this.getStatus()
  }

  // Remote hooks assume POSIX sh.
  async installRemote(sftp: SFTPWrapper, remoteHome: string): Promise<AgentHookInstallStatus> {
    const remoteConfigPath = pathPosix.join(remoteHome, '.kimi-code', 'config.toml')
    const remoteScriptPath = pathPosix.join(
      remoteHome,
      '.orca',
      'agent-hooks',
      POSIX_SCRIPT_FILE_NAME
    )
    try {
      // Kimi creates config lazily; a missing remote file starts empty.
      const text = (await readTextFileRemote(sftp, remoteConfigPath)) ?? ''
      const command = wrapPosixHookCommand(remoteScriptPath)
      // Write the script first so config.toml never points at a missing script.
      await writeManagedScriptRemote(sftp, remoteScriptPath, getManagedScript('posix'))
      await writeTextFileRemoteAtomic(
        sftp,
        remoteConfigPath,
        applyManagedKimiHooks(text, command, isManagedKimiCommand)
      )
      return {
        agent: 'kimi',
        state: 'installed',
        configPath: remoteConfigPath,
        managedHooksPresent: true,
        detail: null
      }
    } catch (err) {
      return {
        agent: 'kimi',
        state: 'error',
        configPath: remoteConfigPath,
        managedHooksPresent: false,
        detail: err instanceof Error ? err.message : String(err)
      }
    }
  }

  remove(): AgentHookInstallStatus {
    const configPath = getConfigPath()
    const text = readConfigToml(configPath)
    if (text === null) {
      return {
        agent: 'kimi',
        state: 'error',
        configPath,
        managedHooksPresent: false,
        detail: 'Could not read Kimi config.toml'
      }
    }
    const { text: nextText, changed } = removeManagedKimiHooks(text, isManagedKimiCommand)
    if (changed) {
      writeConfigToml(configPath, nextText)
    }
    return this.getStatus()
  }
}

export const kimiHookService = new KimiHookService()
