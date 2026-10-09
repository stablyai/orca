import { join, posix as pathPosix } from 'node:path'
import { resolveKiroHomeDir } from '../../shared/kiro-home'
import {
  createManagedCommandMatcher,
  getSharedManagedScriptPath,
  hookDefinitionHasManagedCommand,
  isPlainObject,
  MANAGED_HOOK_TIMEOUT_MILLISECONDS,
  removeManagedCommands,
  wrapPosixHookCommand,
  wrapWindowsHookCommand,
  type HookDefinition
} from '../agent-hooks/installer-utils'

const KIRO_SCRIPT_BASE = 'kiro-hook'

/** Every event Kiro CLI fires to an agent config's `hooks` block (verified on kiro-cli 2.28). */
export const KIRO_HOOK_EVENTS = [
  'agentSpawn',
  'userPromptSubmit',
  'preToolUse',
  'postToolUse',
  'stop'
] as const

const KIRO_TOOL_EVENTS: ReadonlySet<string> = new Set(['preToolUse', 'postToolUse'])

export function isKiroHooksConfigSupported(config: Record<string, unknown>): boolean {
  if (config.hooks === undefined) {
    return true
  }
  if (!isPlainObject(config.hooks)) {
    return false
  }
  const hooks = config.hooks
  return KIRO_HOOK_EVENTS.every(
    (event) => hooks[event] === undefined || Array.isArray(hooks[event])
  )
}

/**
 * Kiro has no global hook config: hooks live in each agent file, and the built-in
 * `kiro_default` agent has none to edit. So Orca patches every global agent the user owns.
 */
export function getKiroAgentsDir(): string {
  return join(resolveKiroHomeDir(), 'agents')
}

/** Without a probed $KIRO_HOME the default matches the CLI's own fallback. */
export function getKiroRemoteAgentsDir(remoteHome: string, kiroHomeDir?: string): string {
  return kiroHomeDir
    ? pathPosix.join(kiroHomeDir, 'agents')
    : pathPosix.join(remoteHome.replace(/\/$/, ''), '.kiro', 'agents')
}

export function isKiroAgentConfigFileName(fileName: string): boolean {
  return fileName.endsWith('.json')
}

export function getKiroManagedScriptFileName(): string {
  return process.platform === 'win32' ? `${KIRO_SCRIPT_BASE}.cmd` : `${KIRO_SCRIPT_BASE}.sh`
}

export function getKiroManagedScriptPath(): string {
  return getSharedManagedScriptPath(getKiroManagedScriptFileName())
}

export function getKiroManagedCommand(scriptPath: string): string {
  // Why: Kiro runs hook commands through PowerShell on Windows and sh elsewhere.
  return process.platform === 'win32'
    ? wrapWindowsHookCommand(scriptPath)
    : wrapPosixHookCommand(scriptPath)
}

export function getKiroRemoteManagedCommand(scriptPath: string): string {
  return wrapPosixHookCommand(scriptPath)
}

export function getKiroManagedCommandMatcher(): (command: string | undefined) => boolean {
  return createManagedCommandMatcher(getKiroManagedScriptFileName())
}

function buildManagedDefinition(event: string, command: string): HookDefinition {
  return {
    ...(KIRO_TOOL_EVENTS.has(event) ? { matcher: '*' } : {}),
    command,
    timeout_ms: MANAGED_HOOK_TIMEOUT_MILLISECONDS
  }
}

function splitDefinitions(value: unknown): { definitions: HookDefinition[]; other: unknown[] } {
  const entries = Array.isArray(value) ? value : []
  return {
    definitions: entries.filter(isPlainObject),
    other: entries.filter((entry) => !isPlainObject(entry))
  }
}

function hasManagedDefinition(
  value: unknown,
  isManagedCommand: (command: string | undefined) => boolean
): boolean {
  return splitDefinitions(value).definitions.some((definition) =>
    hookDefinitionHasManagedCommand(definition, isManagedCommand)
  )
}

/** Returns the agent config with exactly one Orca hook per event, user hooks untouched. */
export function applyManagedKiroHooks(
  config: Record<string, unknown>,
  command: string,
  isManagedCommand: (command: string | undefined) => boolean
): Record<string, unknown> {
  const hooks: Record<string, unknown> = isPlainObject(config.hooks) ? { ...config.hooks } : {}
  for (const event of KIRO_HOOK_EVENTS) {
    const { definitions, other } = splitDefinitions(hooks[event])
    hooks[event] = [
      ...removeManagedCommands(definitions, isManagedCommand),
      ...other,
      buildManagedDefinition(event, command)
    ]
  }
  return { ...config, hooks }
}

export function removeManagedKiroHooks(
  config: Record<string, unknown>,
  isManagedCommand: (command: string | undefined) => boolean
): Record<string, unknown> {
  const original = config.hooks
  if (
    !isPlainObject(original) ||
    !Object.values(original).some((value) => hasManagedDefinition(value, isManagedCommand))
  ) {
    return config
  }
  const hooks: Record<string, unknown> = { ...original }
  for (const [event, value] of Object.entries(hooks)) {
    if (!hasManagedDefinition(value, isManagedCommand)) {
      continue
    }
    const { definitions, other } = splitDefinitions(value)
    const remaining = [...removeManagedCommands(definitions, isManagedCommand), ...other]
    if (remaining.length > 0) {
      hooks[event] = remaining
    } else {
      delete hooks[event]
    }
  }
  if (Object.keys(hooks).length > 0) {
    return { ...config, hooks }
  }
  const { hooks: _emptied, ...rest } = config
  return rest
}

export function readManagedKiroHookEvents(
  config: unknown,
  isManagedCommand: (command: string | undefined) => boolean
): Set<string> {
  const hooks = isPlainObject(config) && isPlainObject(config.hooks) ? config.hooks : {}
  return new Set(
    KIRO_HOOK_EVENTS.filter((event) => hasManagedDefinition(hooks[event], isManagedCommand))
  )
}

export function serializeKiroAgentConfig(config: Record<string, unknown>): string {
  return `${JSON.stringify(config, null, 2)}\n`
}
