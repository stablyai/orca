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

// Why: host-level backstop (seconds) for Orca-managed status hooks. The shell
// wrapper's curl `--max-time 1.5` is the normal dead-endpoint bound; this caps a
// hook the agent host itself runs in case that transport budget is bypassed.
// Intentionally independent of Copilot's `timeoutSec: 5` — both managed budgets
// coexist by design (#4633).
export const MANAGED_HOOK_TIMEOUT_SECONDS = 10
export const MANAGED_HOOK_TIMEOUT_MILLISECONDS = MANAGED_HOOK_TIMEOUT_SECONDS * 1000

// Nested command hook used by the Claude-shaped `hooks: [...]` schema (Claude,
// Codex, Gemini, Droid, Grok, Command Code, Devin).
export function buildManagedCommandHook(
  command: string,
  timeout = MANAGED_HOOK_TIMEOUT_SECONDS
): HookCommandConfig {
  return { type: 'command', command, timeout }
}

// Direct command definition used by schemas that put `command` on the
// definition itself (Cursor's documented top-level shape).
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

// Why: callers in install/remove need to match not just the exact current
// managed command, but also stale entries pointing at old script paths — e.g.
// from a previous dev build with a different Electron userData dir, or a
// parallel dev/prod install. Matching by the managed script's file name
// (under any `agent-hooks/` directory) lets a fresh install sweep those
// without touching unrelated user-authored hooks.
export function createManagedCommandMatcher(
  scriptFileName: string
): (command: string | undefined) => boolean {
  const scriptStem = scriptFileName.replace(/\.(?:cmd|ps1|sh)$/, '')
  // Why: local Windows installs use .cmd or Copilot's .ps1, while SSH/POSIX
  // installs use .sh. A platform switch must still sweep stale Orca hooks.
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

// Why: prod, dev, and parallel Orca instances must write the same managed
// settings entry instead of racing between per-userData script paths.
export function getSharedManagedScriptPath(scriptFileName: string): string {
  return join(homedir(), '.orca', 'agent-hooks', scriptFileName)
}

function quotePosixShellString(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

// Why: a stale managed hook entry (left over after the user wiped userData,
// switched dev↔prod installs, or had a partial install fail) used to fire
// `/bin/sh "<missing path>"` on every tool call, which exits 127 and surfaces
// as `PreToolUse hook (failed) error: hook exited with code 127` in the agent
// transcript. Guarding for a regular readable executable file makes a broken
// install a silent no-op without hiding failures from a script that starts.
export function wrapPosixHookCommand(scriptPath: string, env: Record<string, string> = {}): string {
  // Why: POSIX single-quote escape so $, `, ", and \ in scriptPath are taken
  // literally — avoids a shell-injection footgun if a future caller passes an
  // arbitrary path.
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
  // Why: the encoded launcher protects paths across Windows hook shells and
  // owns stdin when a stale config points at a missing managed script.
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
  // Why: Codex/Antigravity/Devin launch the hook command as a program (argv[0]),
  // NOT through cmd.exe, so the launcher must be a single directly-spawnable
  // token. The bare .cmd path is exactly that. A cmd-builtin `if exist …`
  // launcher is unspawnable — its argv[0] is `if` — so it fails every hook with
  // exit 1 (#8430 regression). A stale/missing script therefore surfaces a normal
  // launch failure here; the missing-script stdin drain lives on the encoded
  // fallback below, which needs a real interpreter for spaces/metacharacters
  // anyway and cannot be reached by a cmd-builtin drain without breaking spawn.
  return WINDOWS_CMD_SAFE_PATH.test(scriptPath) ? scriptPath : wrapWindowsHookCommand(scriptPath)
}

export const WINDOWS_GIT_BASH_SAFE_PATH = /^[A-Za-z0-9_.:/~-]+$/

export function wrapWindowsGitBashHookCommand(scriptPath: string): string {
  const bashPath = scriptPath.replaceAll('\\', '/')
  // Why: Claude's Git Bash runner can execute a forward-slash .cmd directly;
  // unsafe paths stay encoded and the fast path gains a missing-file drain.
  return WINDOWS_GIT_BASH_SAFE_PATH.test(bashPath)
    ? `if [ -f ${quotePosixShellString(bashPath)} ]; then ${quotePosixShellString(bashPath)}; else ${POSIX_HOOK_STDIN_DRAIN_COMMAND}; fi`
    : wrapWindowsHookCommand(scriptPath)
}

export function buildWindowsAgentHookPostCommand(source: AgentHookSource): string {
  // Why: Codex runs these hooks inline on every turn. PowerShell startup alone
  // makes trusted Windows hooks visibly slow, so mirror the POSIX curl path.
  // Qualify curl so a repo-local curl.exe cannot hijack hook payloads.
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

// Why: status hooks fire up to 6× per turn; spawning PowerShell per post adds
// ~300ms of interpreter startup each, which Codex 0.140's synchronous "Running
// <event> hook" rows make visible. curl.exe (Windows 10 1803+) posts the same
// form fields as the POSIX hook and reads the raw payload from stdin via
// `--data-urlencode payload@-`, so UTF-8 (e.g. CJK prompts) survives byte-for-
// byte without the code-page translation that previously forced PowerShell.
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

// Why: temp+rename so concurrent Orca instances writing this shared path can't
// produce a torn script that an in-flight `/bin/sh <scriptPath>` would source.
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
    // Why: chmod before rename so the canonical path is never visible in a
    // unreadable/non-executable state; wrapPosixHookCommand's guards would
    // silently skip the hook in that window.
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

// Why: on Windows, write may fail with EPERM if the target directory has a
// restrictive DACL. Grant an explicit ACL on EPERM and retry once.
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

  // Why: write to a temp file then rename so a crash or disk-full mid-write
  // leaves the original untouched. This is the only safe way to update a
  // config file the user may have hand-edited.
  //
  // Why randomUUID: Date.now() alone collides when two install() calls fire in
  // the same millisecond targeting the same dir (e.g. a future caller that
  // installs multiple agents sharing a config dir, or rapid reinstalls from
  // the settings UI). A collision would corrupt one of the two writes. The
  // UUID suffix makes the tmp path unique per call.
  const tmpPath = join(dir, `.${Date.now()}-${randomUUID()}.tmp`)
  const serialized = `${JSON.stringify(config, null, 2)}\n`

  // Why: skip the write (and therefore the .bak rotation) when the on-disk
  // content is already identical. Without this, every install() rewrites the
  // file and rolls the backup forward, which can silently destroy the last
  // recoverable copy if install() is called repeatedly (e.g. on app start).
  if (existsSync(configPath)) {
    try {
      if (readFileSync(configPath, 'utf-8') === serialized) {
        return
      }
    } catch {
      // Fall through to the normal write path — a read error here is not
      // worth failing the install for; the atomic write below will either
      // succeed or throw loudly.
    }
  }

  try {
    writeFileSync(tmpPath, serialized, 'utf-8')
    // Why: single rolling backup — one file, no accumulation in ~/.claude.
    // Protects against a merge-logic bug producing bad JSON; the original is
    // always recoverable from <configPath>.bak until the next write.
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
