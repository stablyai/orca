import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  copyFileSync,
  renameSync,
  unlinkSync
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AgentHookSource } from '../../shared/agent-hook-relay'
import { grantDirAcl, isPermissionError } from '../win32-utils'
import { POSIX_HOOK_STDIN_DRAIN_COMMAND } from './hook-stdin-contract'

export type HookCommandConfig = {
  type: 'command'
  command: string
  timeout?: number
  async?: boolean
  statusMessage?: string
  [key: string]: unknown
}

export type HookDefinition = {
  matcher?: string
  command?: string
  bash?: string
  powershell?: string
  hooks?: HookCommandConfig[]
  [key: string]: unknown
}

export type HooksConfig = {
  hooks?: Record<string, HookDefinition[]>
  [key: string]: unknown
}

// Why: host-level backstop timeout for status hooks, independent of the curl --max-time and Copilot's timeoutSec (#4633).
export const MANAGED_HOOK_TIMEOUT_SECONDS = 10
export const MANAGED_HOOK_TIMEOUT_MILLISECONDS = MANAGED_HOOK_TIMEOUT_SECONDS * 1000

// Nested command hook for the Claude-shaped `hooks: [...]` schema (Claude, Codex, Gemini, Droid, Grok, Command Code, Devin).
export function buildManagedCommandHook(
  command: string,
  timeout = MANAGED_HOOK_TIMEOUT_SECONDS
): HookCommandConfig {
  return { type: 'command', command, timeout }
}

// Direct command definition for schemas that put `command` on the definition itself (Cursor's top-level shape).
export function buildManagedCommandDefinition(command: string): HookDefinition {
  return { command, timeout: MANAGED_HOOK_TIMEOUT_SECONDS }
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function readHooksJson(configPath: string): HooksConfig | null {
  if (!existsSync(configPath)) {
    return {}
  }

  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf-8'))
    return isPlainObject(parsed) ? parsed : null
  } catch {
    return null
  }
}

// Why: match by script file name, not exact command, so a fresh install sweeps stale entries from old/parallel installs.
export function createManagedCommandMatcher(
  scriptFileName: string
): (command: string | undefined) => boolean {
  const scriptStem = scriptFileName.replace(/\.(?:cmd|ps1|sh)$/, '')
  // Why: installs use .cmd/.ps1 (Windows) or .sh (SSH/POSIX); match all so a platform switch still sweeps stale hooks.
  const needles = [
    `agent-hooks/${scriptFileName}`,
    `agent-hooks/${scriptStem}.cmd`,
    `agent-hooks/${scriptStem}.ps1`,
    `agent-hooks/${scriptStem}.sh`
  ]
  return (command) => {
    if (!command) {
      return false
    }
    const decodedCommand = decodePowerShellEncodedCommand(command)
    const searchText = decodedCommand ? `${command}\n${decodedCommand}` : command
    const normalizedCommand = searchText.replaceAll('\\', '/')
    return needles.some((needle) => normalizedCommand.includes(needle))
  }
}

function decodePowerShellEncodedCommand(command: string): string | null {
  const match = command.match(/\s-EncodedCommand\s+(\S+)/i)
  if (!match) {
    return null
  }
  try {
    return Buffer.from(match[1], 'base64').toString('utf16le')
  } catch {
    return null
  }
}

// Why: prod/dev/parallel Orca instances must write the same managed entry, not race between per-userData script paths.
export function getSharedManagedScriptPath(scriptFileName: string): string {
  return join(homedir(), '.orca', 'agent-hooks', scriptFileName)
}

function quotePosixShellString(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

// Why: guard for a readable executable so a stale entry at a missing script becomes a silent no-op, not an exit-127 failure on every tool call.
export function wrapPosixHookCommand(scriptPath: string, env: Record<string, string> = {}): string {
  // Why: single-quote escape so $, `, ", \ in scriptPath stay literal — avoids shell injection from an arbitrary path.
  const quoted = quotePosixShellString(scriptPath)
  const envPrefix = Object.entries(env)
    .map(([key, value]) => `${key}='${value.replaceAll("'", "'\\''")}'`)
    .join(' ')
  const invocation = envPrefix ? `${envPrefix} /bin/sh ${quoted}` : `/bin/sh ${quoted}`
  return `if [ -f ${quoted} ] && [ -r ${quoted} ] && [ -x ${quoted} ]; then ${invocation}; else ${POSIX_HOOK_STDIN_DRAIN_COMMAND}; fi`
}

function quotePowerShellString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

function getWindowsPowerShellExecutablePath(): string {
  const systemRoot = process.env.SystemRoot || 'C:\\Windows'
  // Why: PATH lookup lets a worktree-local powershell.exe hijack hook payloads.
  // Forward slashes keep this absolute path shell-friendly for cmd.exe and Git Bash.
  return `${systemRoot.replaceAll('\\', '/')}/System32/WindowsPowerShell/v1.0/powershell.exe`
}

export function wrapWindowsHookCommand(
  scriptPath: string,
  env: Record<string, string> = {}
): string {
  // Why: the encoded launcher protects paths across Windows shells and drains stdin when the config points at a missing script.
  const quoted = quotePowerShellString(scriptPath)
  const envPrefix = Object.entries(env)
    .map(([key, value]) => `$env:${key} = ${quotePowerShellString(value)}; `)
    .join('')
  const command = `${envPrefix}if (Test-Path -LiteralPath ${quoted} -PathType Leaf) { & ${quoted}; exit $LASTEXITCODE }; [Console]::In.ReadToEnd() | Out-Null; exit 0`
  const encodedCommand = Buffer.from(command, 'utf16le').toString('base64')
  return `${getWindowsPowerShellExecutablePath()} -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encodedCommand}`
}

export const WINDOWS_CMD_SAFE_PATH = /^[A-Za-z0-9_.:\\~-]+$/

export function wrapWindowsCmdHookCommand(scriptPath: string): string {
  // Why: Codex/Antigravity/Devin spawn the hook as argv[0], not via cmd.exe, so it must be one spawnable token; a cmd `if exist` launcher isn't (#8430).
  return WINDOWS_CMD_SAFE_PATH.test(scriptPath) ? scriptPath : wrapWindowsHookCommand(scriptPath)
}

export const WINDOWS_GIT_BASH_SAFE_PATH = /^[A-Za-z0-9_.:/~-]+$/

export function wrapWindowsGitBashHookCommand(scriptPath: string): string {
  const bashPath = scriptPath.replaceAll('\\', '/')
  // Why: Claude's Git Bash runner can execute a forward-slash .cmd directly; unsafe paths stay encoded.
  return WINDOWS_GIT_BASH_SAFE_PATH.test(bashPath)
    ? `if [ -f ${quotePosixShellString(bashPath)} ]; then ${quotePosixShellString(bashPath)}; else ${POSIX_HOOK_STDIN_DRAIN_COMMAND}; fi`
    : wrapWindowsHookCommand(scriptPath)
}

export function buildWindowsAgentHookPostCommand(source: AgentHookSource): string {
  // Why: PowerShell startup makes inline per-turn Codex hooks visibly slow, so mirror the POSIX curl path.
  // Why: fully-qualify curl so a repo-local curl.exe can't hijack hook payloads.
  return [
    `"%SystemRoot%\\System32\\curl.exe" -sS -X POST "http://127.0.0.1:%ORCA_AGENT_HOOK_PORT%/hook/${source}" ^`,
    '  --connect-timeout 0.5 --max-time 1.5 ^',
    '  -H "Content-Type: application/x-www-form-urlencoded" ^',
    '  -H "X-Orca-Agent-Hook-Token: %ORCA_AGENT_HOOK_TOKEN%" ^',
    '  --data-urlencode "paneKey=%ORCA_PANE_KEY%" ^',
    '  --data-urlencode "tabId=%ORCA_TAB_ID%" ^',
    '  --data-urlencode "launchToken=%ORCA_AGENT_LAUNCH_TOKEN%" ^',
    '  --data-urlencode "worktreeId=%ORCA_WORKTREE_ID%" ^',
    '  --data-urlencode "env=%ORCA_AGENT_HOOK_ENV%" ^',
    '  --data-urlencode "version=%ORCA_AGENT_HOOK_VERSION%" ^',
    '  --data-urlencode "payload@-" >nul 2>nul'
  ].join('\r\n')
}

// Why: PowerShell per-post costs ~300ms startup and mangles UTF-8 via code-page translation; curl.exe (Win10 1803+) avoids both.
export function buildWindowsAgentHookCurlPostCommand(source: AgentHookSource): string {
  return [
    '"%SystemRoot%\\System32\\curl.exe" -sS -X POST',
    `"http://127.0.0.1:%ORCA_AGENT_HOOK_PORT%/hook/${source}"`,
    '--connect-timeout 0.5 --max-time 1.5',
    '-H "Content-Type: application/x-www-form-urlencoded"',
    '-H "X-Orca-Agent-Hook-Token: %ORCA_AGENT_HOOK_TOKEN%"',
    '--data-urlencode "paneKey=%ORCA_PANE_KEY%"',
    '--data-urlencode "tabId=%ORCA_TAB_ID%"',
    '--data-urlencode "launchToken=%ORCA_AGENT_LAUNCH_TOKEN%"',
    '--data-urlencode "worktreeId=%ORCA_WORKTREE_ID%"',
    '--data-urlencode "env=%ORCA_AGENT_HOOK_ENV%"',
    '--data-urlencode "version=%ORCA_AGENT_HOOK_VERSION%"',
    '--data-urlencode "payload@-"',
    '>nul 2>&1'
  ].join(' ')
}

export function removeManagedCommands(
  definitions: HookDefinition[],
  isManagedCommand: (command: string | undefined) => boolean
): HookDefinition[] {
  return definitions.flatMap((definition) => {
    const directCommandKeys = ['command', 'bash', 'powershell'] as const
    const directManagedKeys = directCommandKeys.filter((key) => isManagedCommand(definition[key]))
    const hasNestedHooks = Array.isArray(definition.hooks)
    const hasManagedNestedHook =
      hasNestedHooks && definition.hooks!.some((hook) => isManagedCommand(hook.command))

    if (directManagedKeys.length === 0 && !hasManagedNestedHook) {
      return [definition]
    }

    const nextDefinition: HookDefinition = { ...definition }
    for (const key of directManagedKeys) {
      delete nextDefinition[key]
    }

    if (hasManagedNestedHook) {
      const filteredHooks = definition.hooks!.filter((hook) => !isManagedCommand(hook.command))
      if (filteredHooks.length > 0) {
        nextDefinition.hooks = filteredHooks
      } else {
        delete nextDefinition.hooks
      }
    }

    const hasCommandAfterCleanup =
      directCommandKeys.some((key) => typeof nextDefinition[key] === 'string') ||
      (Array.isArray(nextDefinition.hooks) && nextDefinition.hooks.length > 0)
    if (!hasCommandAfterCleanup) {
      return []
    }

    return [nextDefinition]
  })
}

export function hookDefinitionHasManagedCommand(
  definition: HookDefinition,
  isManagedCommand: (command: string | undefined) => boolean
): boolean {
  return (
    isManagedCommand(definition.command) ||
    isManagedCommand(definition.bash) ||
    isManagedCommand(definition.powershell) ||
    (Array.isArray(definition.hooks) &&
      definition.hooks.some((hook) => isManagedCommand(hook.command)))
  )
}

// Why: temp+rename so concurrent writers can't leave a torn script for an in-flight /bin/sh to source.
export function writeManagedScript(scriptPath: string, content: string): void {
  const dir = dirname(scriptPath)
  mkdirSync(dir, { recursive: true })

  if (existsSync(scriptPath)) {
    try {
      if (readFileSync(scriptPath, 'utf-8') === content) {
        if (process.platform !== 'win32') {
          chmodSync(scriptPath, 0o755)
        }
        return
      }
    } catch {
      // Fall through to the atomic write path.
    }
  }

  const tmpPath = join(dir, `.${Date.now()}-${randomUUID()}.tmp`)
  try {
    writeScriptWithAclRetry(tmpPath, content)
    // Why: chmod before rename so the canonical path is never visible non-executable, else the POSIX guard skips the hook.
    if (process.platform !== 'win32') {
      chmodSync(tmpPath, 0o755)
    }
    renameSync(tmpPath, scriptPath)
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

// Why: a restrictive directory DACL makes writes fail with EPERM on Windows; grant an ACL and retry once.
function writeScriptWithAclRetry(scriptPath: string, content: string): void {
  try {
    writeFileSync(scriptPath, content, 'utf-8')
  } catch (error) {
    if (isPermissionError(error) && process.platform === 'win32') {
      try {
        grantDirAcl(dirname(scriptPath))
        writeFileSync(scriptPath, content, 'utf-8')
        return
      } catch {
        // icacls failure is not actionable; re-throw the original EPERM
      }
    }
    throw error
  }
}

export function writeHooksJson(configPath: string, config: HooksConfig): void {
  const dir = dirname(configPath)
  mkdirSync(dir, { recursive: true })

  // Why: temp+rename leaves the original untouched on a crash/disk-full mid-write.
  // Why randomUUID: avoids tmp-path collisions when two install() calls fire in the same millisecond.
  const tmpPath = join(dir, `.${Date.now()}-${randomUUID()}.tmp`)
  const serialized = `${JSON.stringify(config, null, 2)}\n`

  // Why: skip identical writes so repeated install() calls don't roll the .bak forward and destroy the last recoverable copy.
  if (existsSync(configPath)) {
    try {
      if (readFileSync(configPath, 'utf-8') === serialized) {
        return
      }
    } catch {
      // Fall through to the normal write path; a read error isn't worth failing the install for.
    }
  }

  try {
    writeFileSync(tmpPath, serialized, 'utf-8')
    // Why: single rolling backup so a merge-logic bug producing bad JSON stays recoverable from <configPath>.bak until the next write.
    if (existsSync(configPath)) {
      copyFileSync(configPath, `${configPath}.bak`)
    }
    renameSync(tmpPath, configPath)
  } finally {
    // Clean up temp file if rename failed.
    if (existsSync(tmpPath)) {
      try {
        unlinkSync(tmpPath)
      } catch {
        // best effort
      }
    }
  }
}
