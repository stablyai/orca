import { join, posix as pathPosix } from 'node:path'
import { resolveKiroHomeDir } from '../../shared/kiro-home'
import {
  createManagedCommandMatcher,
  getSharedManagedScriptPath,
  hookDefinitionHasManagedCommand,
  isPlainObject,
  MANAGED_HOOK_TIMEOUT_MILLISECONDS,
  MANAGED_HOOK_TIMEOUT_SECONDS,
  removeManagedCommands,
  wrapPosixHookCommand,
  type HookDefinition
} from '../agent-hooks/installer-utils'
import { wrapWindowsBatchHookCommand } from '../agent-hooks/windows-direct-cmd-hook-command'

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
  if (Array.isArray(config.hooks)) {
    return config.hooks.every(isPlainObject)
  }
  if (!isPlainObject(config.hooks)) {
    return false
  }
  const hooks = config.hooks
  return KIRO_HOOK_EVENTS.every(
    (event) => hooks[event] === undefined || Array.isArray(hooks[event])
  )
}

/** Kiro V2 has no global hook config and no editable built-in agent; patch each user-owned global agent file. */
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
  // Kiro uses PowerShell on Windows, sh elsewhere.
  return process.platform === 'win32'
    ? wrapWindowsBatchHookCommand(scriptPath)
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

/** List-form entry, as in V3 hook files and agents `kiro-cli agent upgrade` rewrote. */
export function buildKiroListHook(trigger: string, command: string): Record<string, unknown> {
  return {
    name: `orca-agent-status-${trigger}`,
    trigger,
    ...(KIRO_TOOL_EVENTS.has(trigger) ? { matcher: '*' } : {}),
    action: { type: 'command', command },
    timeout: MANAGED_HOOK_TIMEOUT_SECONDS
  }
}

export function kiroListHookRunsManagedCommand(
  entry: unknown,
  isManagedCommand: (command: string | undefined) => boolean
): boolean {
  const action = isPlainObject(entry) ? entry.action : undefined
  return (
    isPlainObject(action) && typeof action.command === 'string' && isManagedCommand(action.command)
  )
}

function managedListHookEvent(
  entry: unknown,
  isManagedCommand: (command: string | undefined) => boolean
): string | null {
  if (!isPlainObject(entry) || !kiroListHookRunsManagedCommand(entry, isManagedCommand)) {
    return null
  }
  return KIRO_HOOK_EVENTS.find((event) => event === entry.trigger) ?? null
}

// An upgraded agent carries `permissions`; object-form hooks would knock it out of the universal format.
function usesListHooks(config: Record<string, unknown>): boolean {
  return (
    Array.isArray(config.hooks) || (config.hooks === undefined && isPlainObject(config.permissions))
  )
}

function applyManagedKiroListHooks(
  entries: unknown[],
  command: string,
  isManagedCommand: (command: string | undefined) => boolean
): unknown[] {
  const missing = new Set<string>(KIRO_HOOK_EVENTS)
  const kept = entries.flatMap((entry) => {
    const event = managedListHookEvent(entry, isManagedCommand)
    if (event === null) {
      return [entry]
    }
    // Refresh the first Orca entry per event where it sits; drop duplicates.
    return missing.delete(event) ? [buildKiroListHook(event, command)] : []
  })
  return [...kept, ...[...missing].map((event) => buildKiroListHook(event, command))]
}

function withHooks(
  config: Record<string, unknown>,
  hooks: unknown[] | Record<string, unknown>
): Record<string, unknown> {
  if ((Array.isArray(hooks) ? hooks.length : Object.keys(hooks).length) > 0) {
    return { ...config, hooks }
  }
  const { hooks: _emptied, ...rest } = config
  return rest
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

/** Preserve user hooks while converging to one Orca hook per event. */
export function applyManagedKiroHooks(
  config: Record<string, unknown>,
  command: string,
  isManagedCommand: (command: string | undefined) => boolean
): Record<string, unknown> {
  if (usesListHooks(config)) {
    const entries = Array.isArray(config.hooks) ? config.hooks : []
    return { ...config, hooks: applyManagedKiroListHooks(entries, command, isManagedCommand) }
  }
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
  if (Array.isArray(original)) {
    const hooks = original.filter(
      (entry) => !kiroListHookRunsManagedCommand(entry, isManagedCommand)
    )
    return hooks.length === original.length ? config : withHooks(config, hooks)
  }
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
  return withHooks(config, hooks)
}

export function readManagedKiroHookEvents(
  config: unknown,
  isManagedCommand: (command: string | undefined) => boolean
): Set<string> {
  if (isPlainObject(config) && Array.isArray(config.hooks)) {
    return new Set(
      config.hooks.flatMap((entry) => managedListHookEvent(entry, isManagedCommand) ?? [])
    )
  }
  const hooks = isPlainObject(config) && isPlainObject(config.hooks) ? config.hooks : {}
  return new Set(
    KIRO_HOOK_EVENTS.filter((event) => hasManagedDefinition(hooks[event], isManagedCommand))
  )
}

export function serializeKiroAgentConfig(config: Record<string, unknown>): string {
  return `${JSON.stringify(config, null, 2)}\n`
}
