import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  copyFileSync,
  renameSync,
  unlinkSync
} from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { randomUUID } from 'crypto'
import type { AgentHookSource } from '../../shared/agent-hook-relay'
import { grantDirAcl, isPermissionError } from '../win32-utils'

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
  const needle = `agent-hooks/${scriptFileName}`
  return (command) => {
    if (!command) {
      return false
    }
    return command.replaceAll('\\', '/').includes(needle)
  }
}

// Why: prod, dev, and parallel Orca instances must write the same managed
// settings entry instead of racing between per-userData script paths.
export function getSharedManagedScriptPath(scriptFileName: string): string {
  return join(homedir(), '.orca', 'agent-hooks', scriptFileName)
}

// Why: a stale managed hook entry (left over after the user wiped userData,
// switched dev↔prod installs, or had a partial install fail) used to fire
// `/bin/sh "<missing path>"` on every tool call, which exits 127 and surfaces
// as `PreToolUse hook (failed) error: hook exited with code 127` in the agent
// transcript. Wrapping the launcher in `if [ -x ... ]; then ...; fi` makes a
// missing/non-executable script a silent no-op so a broken install never
// poisons the user's session. Failures inside the script itself are
// unaffected — only the missing-script case short-circuits.
export function wrapPosixHookCommand(scriptPath: string, env: Record<string, string> = {}): string {
  // Why: POSIX single-quote escape so $, `, ", and \ in scriptPath are taken
  // literally — avoids a shell-injection footgun if a future caller passes an
  // arbitrary path.
  const quoted = `'${scriptPath.replaceAll("'", "'\\''")}'`
  const envPrefix = Object.entries(env)
    .map(([key, value]) => `${key}='${value.replaceAll("'", "'\\''")}'`)
    .join(' ')
  const invocation = envPrefix ? `${envPrefix} /bin/sh ${quoted}` : `/bin/sh ${quoted}`
  return `if [ -x ${quoted} ]; then ${invocation}; fi`
}

export function buildWindowsAgentHookPostCommand(source: AgentHookSource): string {
  // Why: Windows PowerShell 5.1 defaults redirected stdin/request bodies to the
  // active code page. Hook payloads are UTF-8 JSON, so force UTF-8 on both read
  // and POST or CJK prompts arrive in Orca as literal question marks.
  return `powershell -NoProfile -ExecutionPolicy Bypass -Command "$utf8=[System.Text.UTF8Encoding]::new($false); [Console]::InputEncoding=$utf8; [Console]::OutputEncoding=$utf8; $inputData=[Console]::In.ReadToEnd(); if ([string]::IsNullOrWhiteSpace($inputData)) { exit 0 }; try { $body=@{ paneKey=$env:ORCA_PANE_KEY; tabId=$env:ORCA_TAB_ID; worktreeId=$env:ORCA_WORKTREE_ID; env=$env:ORCA_AGENT_HOOK_ENV; version=$env:ORCA_AGENT_HOOK_VERSION; payload=($inputData | ConvertFrom-Json) } | ConvertTo-Json -Depth 100 -Compress; $bodyBytes=$utf8.GetBytes($body); Invoke-WebRequest -UseBasicParsing -Method Post -Uri ('http://127.0.0.1:' + $env:ORCA_AGENT_HOOK_PORT + '/hook/${source}') -ContentType 'application/json; charset=utf-8' -Headers @{ 'X-Orca-Agent-Hook-Token'=$env:ORCA_AGENT_HOOK_TOKEN } -Body $bodyBytes | Out-Null } catch {}"`
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
    // non-executable state; wrapPosixHookCommand's `[ -x ]` guard would
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
