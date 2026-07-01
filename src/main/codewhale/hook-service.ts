import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'fs'
import { randomUUID } from 'crypto'
import { homedir } from 'os'
import { dirname, join, posix as pathPosix } from 'path'
import type { SFTPWrapper } from 'ssh2'
import type { AgentHookInstallState, AgentHookInstallStatus } from '../../shared/agent-hook-types'
import {
  createManagedCommandMatcher,
  getSharedManagedScriptPath,
  wrapPosixHookCommand,
  writeManagedScript
} from '../agent-hooks/installer-utils'
import {
  readTextFileRemote,
  writeManagedScriptRemote,
  writeTextFileRemoteAtomic
} from '../agent-hooks/installer-utils-remote'
import {
  applyManagedCodeWhaleHooks,
  CODEWHALE_HOOK_EVENTS,
  type CodeWhaleHookEvent,
  readManagedCodeWhaleHookEvents,
  removeManagedCodeWhaleHooks
} from './hook-config-toml'
import { getManagedCodeWhaleWindowsScript } from './codewhale-windows-hook-script'

const POSIX_SCRIPT_FILE_NAME = 'codewhale-hook.sh'
const WINDOWS_SCRIPT_FILE_NAME = 'codewhale-hook.cmd'

function envPath(name: 'CODEWHALE_CONFIG_PATH' | 'DEEPSEEK_CONFIG_PATH'): string | null {
  const value = process.env[name]?.trim()
  return value ? value : null
}

function getConfigPath(): string {
  const explicitCodeWhale = envPath('CODEWHALE_CONFIG_PATH')
  if (explicitCodeWhale) {
    return explicitCodeWhale
  }
  const explicitDeepSeek = envPath('DEEPSEEK_CONFIG_PATH')
  if (explicitDeepSeek) {
    return explicitDeepSeek
  }
  return join(homedir(), '.codewhale', 'config.toml')
}

function getManagedScriptFileName(): string {
  return process.platform === 'win32' ? WINDOWS_SCRIPT_FILE_NAME : POSIX_SCRIPT_FILE_NAME
}

function getManagedScriptPath(): string {
  return getSharedManagedScriptPath(getManagedScriptFileName())
}

function quoteWindowsCmdPath(scriptPath: string): string {
  return `"${scriptPath.replaceAll('"', '""')}"`
}

function getManagedCommand(scriptPath: string, event: CodeWhaleHookEvent): string {
  if (process.platform === 'win32') {
    return `set "ORCA_CODEWHALE_HOOK_EVENT=${event}" && ${quoteWindowsCmdPath(scriptPath)}`
  }
  return wrapPosixHookCommand(scriptPath, { ORCA_CODEWHALE_HOOK_EVENT: event })
}

function getManagedPosixScript(): string {
  return [
    '#!/bin/sh',
    // Why: refresh PORT/TOKEN/ENV/VERSION from the current Orca process so a
    // terminal that survived app restart still posts to the live listener.
    'if [ -n "$ORCA_AGENT_HOOK_ENDPOINT" ] && [ -r "$ORCA_AGENT_HOOK_ENDPOINT" ]; then',
    '  . "$ORCA_AGENT_HOOK_ENDPOINT" 2>/dev/null || :',
    'fi',
    'if [ -z "$ORCA_AGENT_HOOK_PORT" ] || [ -z "$ORCA_AGENT_HOOK_TOKEN" ] || [ -z "$ORCA_PANE_KEY" ]; then',
    '  exit 0',
    'fi',
    // Why: CodeWhale observer hooks expose data through DEEPSEEK_* env vars and
    // inherit the TUI stdin; reading stdin here can block until hook timeout.
    'payload="{}"',
    'curl -sS -X POST "http://127.0.0.1:${ORCA_AGENT_HOOK_PORT}/hook/codewhale" \\',
    '  --connect-timeout 0.5 --max-time 1.5 \\',
    '  -H "Content-Type: application/x-www-form-urlencoded" \\',
    '  -H "X-Orca-Agent-Hook-Token: ${ORCA_AGENT_HOOK_TOKEN}" \\',
    '  --data-urlencode "paneKey=${ORCA_PANE_KEY}" \\',
    '  --data-urlencode "tabId=${ORCA_TAB_ID}" \\',
    '  --data-urlencode "launchToken=${ORCA_AGENT_LAUNCH_TOKEN}" \\',
    '  --data-urlencode "worktreeId=${ORCA_WORKTREE_ID}" \\',
    '  --data-urlencode "env=${ORCA_AGENT_HOOK_ENV}" \\',
    '  --data-urlencode "version=${ORCA_AGENT_HOOK_VERSION}" \\',
    '  --data-urlencode "hook_event_name=${ORCA_CODEWHALE_HOOK_EVENT}" \\',
    '  --data-urlencode "payload=${payload}" \\',
    '  --data-urlencode "deepseekToolName=${DEEPSEEK_TOOL_NAME}" \\',
    '  --data-urlencode "deepseekToolArgs=${DEEPSEEK_TOOL_ARGS}" \\',
    '  --data-urlencode "deepseekToolResult=${DEEPSEEK_TOOL_RESULT}" \\',
    '  --data-urlencode "deepseekToolExitCode=${DEEPSEEK_TOOL_EXIT_CODE}" \\',
    '  --data-urlencode "deepseekToolSuccess=${DEEPSEEK_TOOL_SUCCESS}" \\',
    '  --data-urlencode "deepseekError=${DEEPSEEK_ERROR}" \\',
    '  --data-urlencode "deepseekSessionId=${DEEPSEEK_SESSION_ID}" \\',
    '  --data-urlencode "deepseekMessage=${DEEPSEEK_MESSAGE}" \\',
    '  --data-urlencode "deepseekWorkspace=${DEEPSEEK_WORKSPACE}" \\',
    '  --data-urlencode "deepseekModel=${DEEPSEEK_MODEL}" \\',
    '  --data-urlencode "deepseekTotalTokens=${DEEPSEEK_TOTAL_TOKENS}" >/dev/null 2>&1 || true',
    'exit 0',
    ''
  ].join('\n')
}

function getManagedScript(): string {
  return process.platform === 'win32' ? getManagedCodeWhaleWindowsScript() : getManagedPosixScript()
}

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

function writeConfigToml(configPath: string, text: string): void {
  const dir = dirname(configPath)
  mkdirSync(dir, { recursive: true })
  if (existsSync(configPath)) {
    try {
      if (readFileSync(configPath, 'utf-8') === text) {
        return
      }
    } catch {
      // Fall through to the atomic write path.
    }
  }
  const tmpPath = join(dir, `.${Date.now()}-${randomUUID()}.tmp`)
  try {
    writeFileSync(tmpPath, text, 'utf-8')
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
  const missing = CODEWHALE_HOOK_EVENTS.filter((event) => !present.has(event))
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
  return { agent: 'codewhale', state, configPath, managedHooksPresent: present.size > 0, detail }
}

function readStatusFromText(configPath: string, text: string): AgentHookInstallStatus {
  const matcher = createManagedCommandMatcher(getManagedScriptFileName())
  return buildStatus(readManagedCodeWhaleHookEvents(text, matcher), configPath)
}

export class CodeWhaleHookService {
  getStatus(): AgentHookInstallStatus {
    const configPath = getConfigPath()
    const text = readConfigToml(configPath)
    if (text === null) {
      return {
        agent: 'codewhale',
        state: 'error',
        configPath,
        managedHooksPresent: false,
        detail: 'Could not read CodeWhale config.toml'
      }
    }
    return readStatusFromText(configPath, text)
  }

  install(): AgentHookInstallStatus {
    const configPath = getConfigPath()
    const text = readConfigToml(configPath)
    if (text === null) {
      return {
        agent: 'codewhale',
        state: 'error',
        configPath,
        managedHooksPresent: false,
        detail: 'Could not read CodeWhale config.toml'
      }
    }
    const scriptPath = getManagedScriptPath()
    const matcher = createManagedCommandMatcher(getManagedScriptFileName())
    writeManagedScript(scriptPath, getManagedScript())
    writeConfigToml(
      configPath,
      applyManagedCodeWhaleHooks(text, (event) => getManagedCommand(scriptPath, event), matcher)
    )
    return this.getStatus()
  }

  async installRemote(sftp: SFTPWrapper, remoteHome: string): Promise<AgentHookInstallStatus> {
    const codeWhaleConfigPath = pathPosix.join(remoteHome, '.codewhale', 'config.toml')
    const remoteScriptPath = pathPosix.join(
      remoteHome,
      '.orca',
      'agent-hooks',
      POSIX_SCRIPT_FILE_NAME
    )
    try {
      const text = (await readTextFileRemote(sftp, codeWhaleConfigPath)) ?? ''
      await writeManagedScriptRemote(sftp, remoteScriptPath, getManagedPosixScript())
      const matcher = createManagedCommandMatcher(POSIX_SCRIPT_FILE_NAME)
      await writeTextFileRemoteAtomic(
        sftp,
        codeWhaleConfigPath,
        applyManagedCodeWhaleHooks(text, (event) =>
          wrapPosixHookCommand(remoteScriptPath, { ORCA_CODEWHALE_HOOK_EVENT: event }),
          matcher
        )
      )
      return {
        agent: 'codewhale',
        state: 'installed',
        configPath: codeWhaleConfigPath,
        managedHooksPresent: true,
        detail: null
      }
    } catch (err) {
      return {
        agent: 'codewhale',
        state: 'error',
        configPath: codeWhaleConfigPath,
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
        agent: 'codewhale',
        state: 'error',
        configPath,
        managedHooksPresent: false,
        detail: 'Could not read CodeWhale config.toml'
      }
    }
    const matcher = createManagedCommandMatcher(getManagedScriptFileName())
    const { text: nextText, changed } = removeManagedCodeWhaleHooks(text, matcher)
    if (changed) {
      writeConfigToml(configPath, nextText)
    }
    return this.getStatus()
  }
}

export const codeWhaleHookService = new CodeWhaleHookService()
