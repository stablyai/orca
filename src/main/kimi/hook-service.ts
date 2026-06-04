import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { SFTPWrapper } from 'ssh2'
import type { AgentHookInstallState, AgentHookInstallStatus } from '../../shared/agent-hook-types'
import {
  buildWindowsAgentHookPostCommand,
  getSharedManagedScriptPath,
  wrapPosixHookCommand,
  writeManagedScript
} from '../agent-hooks/installer-utils'
import {
  readTextFileRemote,
  writeManagedScriptRemote,
  writeTextFileRemoteAtomic
} from '../agent-hooks/installer-utils-remote'
// Why: reuse the generic TOML escaper + atomic config writer the Codex trust
// path already owns rather than re-deriving the escape table here.
import { escapeTomlString, writeConfigAtomically } from '../codex/config-toml-trust'

// Why: Kimi Code's lifecycle hooks mirror Claude Code's event names, so the
// shared listener routes /hook/kimi through normalizeKimiEvent. SessionStart
// clears stale turn state on open/resume, UserPromptSubmit starts a turn
// (working), tool events keep it working, PermissionRequest flips the pane to
// the waiting red dot (tool approvals AND plan/ExitPlanMode), PermissionResult
// resumes work, Stop/StopFailure end it. The remaining Kimi events
// (SessionEnd/Subagent*/PreCompact/PostCompact/Notification) are observation-
// only and never drive the status, so they are intentionally not installed.
const KIMI_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'PermissionResult',
  'Stop',
  'StopFailure'
] as const

// Why: Kimi Code keeps its hooks in a single config.toml. We own a delimited
// block so install/remove never disturbs the user's own [[hooks]] or settings.
const MANAGED_BLOCK_START = '# >>> orca-managed-hooks >>>'
const MANAGED_BLOCK_END = '# <<< orca-managed-hooks <<<'
const HOOK_TIMEOUT_SECONDS = 5

function getKimiConfigDir(): string {
  // Why: Kimi Code migrated off the legacy ~/.kimi (Python) home to ~/.kimi-code,
  // and resolves its home as `KIMI_CODE_HOME ?? ~/.kimi-code` — mirror that so a
  // custom home (or a test) lands in the same config.toml the CLI reads.
  return process.env.KIMI_CODE_HOME ?? join(homedir(), '.kimi-code')
}

function getConfigPath(): string {
  return join(getKimiConfigDir(), 'config.toml')
}

function getManagedScriptFileName(): string {
  return process.platform === 'win32' ? 'kimi-hook.cmd' : 'kimi-hook.sh'
}

function getManagedScriptPath(): string {
  return getSharedManagedScriptPath(getManagedScriptFileName())
}

function getManagedCommand(scriptPath: string): string {
  return process.platform === 'win32' ? scriptPath : wrapPosixHookCommand(scriptPath)
}

function getManagedScript(target: 'local' | 'posix' = 'local'): string {
  if (target === 'local' && process.platform === 'win32') {
    return [
      '@echo off',
      'setlocal',
      // Why: see claude/hook-service.ts. Sourcing the endpoint file refreshes
      // PORT/TOKEN for a PTY that survived an Orca restart.
      'if defined ORCA_AGENT_HOOK_ENDPOINT if exist "%ORCA_AGENT_HOOK_ENDPOINT%" call "%ORCA_AGENT_HOOK_ENDPOINT%" 2>nul',
      'if "%ORCA_AGENT_HOOK_PORT%"=="" exit /b 0',
      'if "%ORCA_AGENT_HOOK_TOKEN%"=="" exit /b 0',
      'if "%ORCA_PANE_KEY%"=="" exit /b 0',
      buildWindowsAgentHookPostCommand('kimi'),
      'exit /b 0',
      ''
    ].join('\r\n')
  }

  return [
    '#!/bin/sh',
    // Why: see claude/hook-service.ts. Sourcing refreshes PORT/TOKEN/ENV/VERSION
    // from the current Orca so a surviving PTY keeps reporting after a restart.
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
    // Why: post the raw Kimi hook JSON (delivered on stdin) plus pane metadata as
    // form fields; the shared listener parses `payload` back into the event.
    'curl -sS -X POST "http://127.0.0.1:${ORCA_AGENT_HOOK_PORT}/hook/kimi" \\',
    '  --connect-timeout 0.5 --max-time 1.5 \\',
    '  -H "Content-Type: application/x-www-form-urlencoded" \\',
    '  -H "X-Orca-Agent-Hook-Token: ${ORCA_AGENT_HOOK_TOKEN}" \\',
    '  --data-urlencode "paneKey=${ORCA_PANE_KEY}" \\',
    '  --data-urlencode "tabId=${ORCA_TAB_ID}" \\',
    '  --data-urlencode "worktreeId=${ORCA_WORKTREE_ID}" \\',
    '  --data-urlencode "env=${ORCA_AGENT_HOOK_ENV}" \\',
    '  --data-urlencode "version=${ORCA_AGENT_HOOK_VERSION}" \\',
    '  --data-urlencode "payload=${payload}" >/dev/null 2>&1 || true',
    'exit 0',
    ''
  ].join('\n')
}

function buildManagedHooksBlock(command: string): string {
  const escaped = escapeTomlString(command)
  const entries = KIMI_EVENTS.map((event) =>
    [
      '[[hooks]]',
      `event = "${event}"`,
      `command = "${escaped}"`,
      `timeout = ${HOOK_TIMEOUT_SECONDS}`
    ].join('\n')
  )
  return [MANAGED_BLOCK_START, entries.join('\n\n'), MANAGED_BLOCK_END].join('\n')
}

/** Remove Orca's managed block (and the whitespace that framed it) from a
 *  config.toml so install rewrites stay idempotent and remove leaves the
 *  user's own content untouched. */
function stripManagedBlock(content: string): string {
  const start = content.indexOf(MANAGED_BLOCK_START)
  if (start === -1) {
    return content
  }
  const endMarker = content.indexOf(MANAGED_BLOCK_END, start)
  const end = endMarker === -1 ? content.length : endMarker + MANAGED_BLOCK_END.length
  const before = content.slice(0, start).replace(/[ \t]*(?:\r?\n)*$/, '')
  const after = content.slice(end).replace(/^(?:\r?\n)+/, '')
  if (!before) {
    return after
  }
  if (!after) {
    return before.endsWith('\n') ? before : `${before}\n`
  }
  return `${before}\n\n${after}`
}

function extractManagedBlock(content: string): string | null {
  const start = content.indexOf(MANAGED_BLOCK_START)
  if (start === -1) {
    return null
  }
  const endMarker = content.indexOf(MANAGED_BLOCK_END, start)
  return content.slice(start, endMarker === -1 ? content.length : endMarker)
}

function buildConfigWithManagedBlock(existing: string, command: string): string {
  const base = stripManagedBlock(existing).replace(/\s*$/, '')
  const block = buildManagedHooksBlock(command)
  return base.length > 0 ? `${base}\n\n${block}\n` : `${block}\n`
}

function readConfig(configPath: string): string | null {
  if (!existsSync(configPath)) {
    return ''
  }
  try {
    return readFileSync(configPath, 'utf-8')
  } catch {
    return null
  }
}

export class KimiHookService {
  getStatus(): AgentHookInstallStatus {
    const configPath = getConfigPath()
    const content = readConfig(configPath)
    if (content === null) {
      return {
        agent: 'kimi',
        state: 'error',
        configPath,
        managedHooksPresent: false,
        detail: 'Could not read Kimi config.toml'
      }
    }

    const block = extractManagedBlock(content)
    if (block === null) {
      return {
        agent: 'kimi',
        state: 'not_installed',
        configPath,
        managedHooksPresent: false,
        detail: null
      }
    }

    const command = getManagedCommand(getManagedScriptPath())
    const missing = KIMI_EVENTS.filter(
      (event) => !new RegExp(`event\\s*=\\s*"${event}"`).test(block)
    )
    // Why: a block left by an older build (or dev↔prod userData swap) points at a
    // stale script path. Treat that as partial so a reinstall repairs it.
    const hasCurrentCommand = block.includes(`command = "${escapeTomlString(command)}"`)

    let state: AgentHookInstallState
    let detail: string | null
    if (missing.length === 0 && hasCurrentCommand) {
      state = 'installed'
      detail = null
    } else {
      state = 'partial'
      const parts: string[] = []
      if (missing.length > 0) {
        parts.push(`Managed hook missing for events: ${missing.join(', ')}`)
      }
      if (!hasCurrentCommand) {
        parts.push('Managed hook points at a stale script path; reinstall to repair')
      }
      detail = parts.join('; ')
    }
    return { agent: 'kimi', state, configPath, managedHooksPresent: true, detail }
  }

  install(): AgentHookInstallStatus {
    const configPath = getConfigPath()
    const existing = readConfig(configPath)
    if (existing === null) {
      return {
        agent: 'kimi',
        state: 'error',
        configPath,
        managedHooksPresent: false,
        detail: 'Could not read Kimi config.toml'
      }
    }

    const scriptPath = getManagedScriptPath()
    const next = buildConfigWithManagedBlock(existing, getManagedCommand(scriptPath))
    writeManagedScript(scriptPath, getManagedScript())
    if (next !== existing) {
      writeConfigAtomically(configPath, next)
    }
    return this.getStatus()
  }

  // Why: install Orca's Kimi hooks on the remote box for SSH workspaces. POSIX
  // only by design (remote Windows is gated higher up, matching Claude/Codex).
  async installRemote(sftp: SFTPWrapper, remoteHome: string): Promise<AgentHookInstallStatus> {
    const home = remoteHome.replace(/\/$/, '')
    const remoteConfigPath = `${home}/.kimi-code/config.toml`
    const remoteScriptPath = `${home}/.orca/agent-hooks/kimi-hook.sh`
    try {
      const existing = (await readTextFileRemote(sftp, remoteConfigPath)) ?? ''
      const command = wrapPosixHookCommand(remoteScriptPath)
      const next = buildConfigWithManagedBlock(existing, command)
      // Why: write the script first so config.toml never references a missing body.
      await writeManagedScriptRemote(sftp, remoteScriptPath, getManagedScript('posix'))
      if (next !== existing) {
        await writeTextFileRemoteAtomic(sftp, remoteConfigPath, next)
      }
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
    const existing = readConfig(configPath)
    if (existing === null) {
      return {
        agent: 'kimi',
        state: 'error',
        configPath,
        managedHooksPresent: false,
        detail: 'Could not read Kimi config.toml'
      }
    }
    if (existsSync(configPath)) {
      const stripped = stripManagedBlock(existing)
      if (stripped !== existing) {
        writeConfigAtomically(
          configPath,
          stripped.length === 0 || stripped.endsWith('\n') ? stripped : `${stripped}\n`
        )
      }
    }
    return this.getStatus()
  }
}

export const kimiHookService = new KimiHookService()
