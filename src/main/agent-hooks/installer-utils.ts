import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
  chmodSync,
  renameSync,
  unlinkSync
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AgentHookSource } from '../../shared/agent-hook-relay'
import { grantDirAcl, isPermissionError } from '../win32-utils'
import { resolveHooksJsonWritePath } from './hook-config-write-path'
import { writeRollingFileBackup } from '../rolling-file-backup'
import { renameOverLockedTarget } from './locked-executable-rename'
import {
  getWindowsNativeHookAgent,
  WINDOWS_NATIVE_HOOK_EXECUTABLE_NAME
} from './windows-native-hook-executable'

export type HookCommandConfig = {
  type: 'command'
  command: string
  args?: string[]
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

// Host-level backstop independent of curl and provider-specific timeouts.
export const MANAGED_HOOK_TIMEOUT_SECONDS = 10
export const MANAGED_HOOK_TIMEOUT_MILLISECONDS = MANAGED_HOOK_TIMEOUT_SECONDS * 1000

// Claude-shaped schemas nest command hooks; Cursor puts command on the definition itself.
export function buildManagedCommandHook(
  command: string,
  timeout = MANAGED_HOOK_TIMEOUT_SECONDS
): HookCommandConfig {
  return { type: 'command', command, timeout }
}

export function buildManagedCommandDefinition(command: string): HookDefinition {
  return { command, timeout: MANAGED_HOOK_TIMEOUT_SECONDS }
}

export {
  isPlainObject,
  readHooksJson,
  readHooksJsonWithRaw,
  type HooksJsonSnapshot
} from './hooks-json-read'

// Match script names so reinstalls sweep entries from old and parallel installations.
export function createManagedCommandMatcher(
  scriptFileName: string
): (command: string | undefined) => boolean {
  const scriptStem = scriptFileName.replace(/\.(?:cmd|ps1|sh)$/, '')
  // Sweep every platform suffix after a platform switch.
  const needles = [
    `agent-hooks/${scriptFileName}`,
    `agent-hooks/${scriptStem}.cmd`,
    `agent-hooks/${scriptStem}.ps1`,
    `agent-hooks/${scriptStem}.sh`
  ]
  // The native executable selects its provider through argv[1].
  const nativeHook = `agent-hooks/${WINDOWS_NATIVE_HOOK_EXECUTABLE_NAME} ${getWindowsNativeHookAgent(scriptFileName)} `
  return (command) => {
    if (!command) {
      return false
    }
    const decodedCommand = decodePowerShellEncodedCommand(command)
    const searchText = decodedCommand ? `${command}\n${decodedCommand}` : command
    const normalizedCommand = searchText.replaceAll('\\', '/')
    return (
      needles.some((needle) => normalizedCommand.includes(needle)) ||
      normalizedCommand.split('\n').some((line) => `${line} `.includes(nativeHook))
    )
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

// Parallel Orca instances must share one user-wide script path.
export function getSharedManagedScriptPath(scriptFileName: string): string {
  return join(homedir(), '.orca', 'agent-hooks', scriptFileName)
}

export { wrapPosixHookCommand } from './posix-hook-command'

export {
  wrapWindowsPowerShellEncodedCommand,
  WINDOWS_POWERSHELL_HOOK_SWITCHES
} from './windows-powershell-hook-launcher'

export {
  buildWindowsHookPowerShellCommand,
  isSafeUnicodeWindowsBatchHookPath,
  WINDOWS_CMD_SAFE_PATH,
  wrapWindowsHookCommand
} from './windows-hook-command'

/** Extra form lines precede payload@- and must end with ` ^`. */
export function buildWindowsAgentHookPostCommand(
  source: AgentHookSource,
  extraFormLines: readonly string[] = []
): string {
  // Avoid PowerShell startup; qualify curl to prevent repo-local payload interception.
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
    ...extraFormLines,
    '  --data-urlencode "payload@-" >nul 2>nul'
  ].join('\r\n')
}

// curl.exe avoids PowerShell startup and code-page corruption of UTF-8 payloads.
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
      hasNestedHooks &&
      definition.hooks!.some((hook) => hookHasManagedCommand(hook, isManagedCommand))

    if (directManagedKeys.length === 0 && !hasManagedNestedHook) {
      return [definition]
    }

    const nextDefinition: HookDefinition = { ...definition }
    for (const key of directManagedKeys) {
      delete nextDefinition[key]
    }

    if (hasManagedNestedHook) {
      const filteredHooks = definition.hooks!.filter(
        (hook) => !hookHasManagedCommand(hook, isManagedCommand)
      )
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

function hookHasManagedCommand(hook: HookCommandConfig, matches: (value?: string) => boolean) {
  const args = Array.isArray(hook.args) ? hook.args : []
  return matches(hook.command) || args.some((arg) => typeof arg === 'string' && matches(arg))
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
      definition.hooks.some((hook) => hookHasManagedCommand(hook, isManagedCommand)))
  )
}

// Atomic replacement protects scripts being read by in-flight hooks.
export function writeManagedScript(
  scriptPath: string,
  content: string | Buffer,
  options: { moveLockedTargetAside?: boolean } = {}
): void {
  const dir = dirname(scriptPath)
  mkdirSync(dir, { recursive: true })

  if (existsSync(scriptPath)) {
    try {
      if (readFileSync(scriptPath).equals(Buffer.from(content))) {
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
    // Publish with execute permission so POSIX guards never skip a newly installed script.
    if (process.platform !== 'win32') {
      chmodSync(tmpPath, 0o755)
    }
    renameOverLockedTarget(tmpPath, scriptPath, options.moveLockedTargetAside === true)
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

// Retry Windows EPERM once after repairing a restrictive directory ACL.
function writeScriptWithAclRetry(scriptPath: string, content: string | Buffer): void {
  try {
    writeFileSync(scriptPath, content, 'utf-8')
  } catch (error) {
    if (isPermissionError(error) && process.platform === 'win32') {
      try {
        grantDirAcl(dirname(scriptPath))
        writeFileSync(scriptPath, content, 'utf-8')
        return
      } catch {
        // a failed grant is not actionable; re-throw the original EPERM
      }
    }
    throw error
  }
}

export function writeHooksJson(
  configPath: string,
  // Fallback serialization accepts provider-specific JSON shapes, including nested hooks.events.
  config: Record<string, unknown>,
  // JSONC callers supply edited text while retaining atomic writes and backups.
  options?: { preserveMode?: boolean; defaultMode?: number; serialized?: string }
): void {
  const writePath = resolveHooksJsonWritePath(configPath)
  const dir = dirname(writePath)
  mkdirSync(dir, { recursive: true })

  // Unique temp paths isolate concurrent writers and preserve the original on write failure.
  const tmpPath = join(dir, `.${Date.now()}-${randomUUID()}.tmp`)
  const serialized = options?.serialized ?? `${JSON.stringify(config, null, 2)}\n`
  // Preserve owner-only permissions: agent configs can contain API keys.
  const existingMode =
    options?.preserveMode !== false && existsSync(writePath)
      ? statSync(writePath).mode & 0o777
      : options?.defaultMode

  // Identical reinstalls must not rotate away the last recoverable backup.
  if (existsSync(writePath)) {
    try {
      if (readFileSync(writePath, 'utf-8') === serialized) {
        return
      }
    } catch {
      // Retry through the write path after a failed read.
    }
  }

  try {
    // Windows read-only mode could prevent deleting a failed temporary write.
    const tmpMode = process.platform === 'win32' ? undefined : existingMode
    writeFileSync(tmpPath, serialized, { encoding: 'utf-8', mode: tmpMode, flag: 'wx' })
    if (existingMode !== undefined && process.platform !== 'win32') {
      // Preserve requested permissions even with a stricter process umask.
      chmodSync(tmpPath, existingMode)
    }
    // Keep one prior version for recovery from a bad merge.
    if (existsSync(writePath)) {
      writeRollingFileBackup(writePath, `${writePath}.bak`)
    }
    renameSync(tmpPath, writePath)
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

export { writeHooksJsonAsync } from './hooks-json-write-async'
