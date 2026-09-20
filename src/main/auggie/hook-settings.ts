import { homedir } from 'node:os'
import { join, posix as pathPosix } from 'node:path'
import {
  buildManagedCommandHook,
  createManagedCommandMatcher,
  getSharedManagedScriptPath,
  MANAGED_HOOK_TIMEOUT_MILLISECONDS,
  removeManagedCommands,
  type HookCommandConfig,
  type HookDefinition,
  type HooksConfig
} from '../agent-hooks/installer-utils'

// Why: Auggie's `command` must be a bare script path (.sh/.ps1/.cmd/.bat) — it rejects the
// compound shell wrapper every other Claude-shaped agent uses.
export type AuggieEventDefinition = {
  eventName: 'SessionStart' | 'SessionEnd' | 'PreToolUse' | 'PostToolUse' | 'Stop' | 'PromptSubmit'
  // Why: matcher is unsupported (and unused) on session/turn-boundary events per the docs.
  needsMatcher: boolean
  metadata?: Record<string, unknown>
}

export const AUGGIE_EVENTS: readonly AuggieEventDefinition[] = [
  { eventName: 'SessionStart', needsMatcher: false },
  { eventName: 'SessionEnd', needsMatcher: false },
  // Why: fires on every user turn (unlike SessionStart, which only fires once per process) —
  // Auggie's real per-turn boundary, added in a build newer than this integration's original.
  { eventName: 'PromptSubmit', needsMatcher: false },
  { eventName: 'PreToolUse', needsMatcher: true },
  { eventName: 'PostToolUse', needsMatcher: true },
  // Why: userPrompt/agentTextResponse are the only prompt/response fields Auggie exposes;
  // without this flag Stop carries only agent_stop_cause.
  { eventName: 'Stop', needsMatcher: false, metadata: { includeConversationData: true } }
] as const

export function getConfigPath(): string {
  return join(homedir(), '.augment', 'settings.json')
}

export function getRemoteConfigPath(remoteHome: string): string {
  return pathPosix.join(remoteHome, '.augment', 'settings.json')
}

// Why: `.sh`/`.cmd` can't share one file across platforms; filename uses agent id 'aug' (not
// 'auggie') to match the `${agent}-hook.*` convention every managed script follows.
export function getManagedScriptFileName(): string {
  return process.platform === 'win32' ? 'aug-hook.cmd' : getPosixManagedScriptFileName()
}

export function getPosixManagedScriptFileName(): string {
  return 'aug-hook.sh'
}

export function getManagedScriptPath(): string {
  return getSharedManagedScriptPath(getManagedScriptFileName())
}

// Why: no wrapping — the literal absolute path loses $HOME-relative portability, a tradeoff
// Kimi already accepts for its own non-standard invocation shape.
export function getManagedHook(scriptPath: string): HookCommandConfig {
  return buildManagedCommandHook(scriptPath, MANAGED_HOOK_TIMEOUT_MILLISECONDS)
}

export function applyManagedHooks(
  config: HooksConfig,
  hook: HookCommandConfig,
  scriptFileName = getManagedScriptFileName()
): HooksConfig {
  const nextHooks = { ...config.hooks }
  const isManagedCommand = createManagedCommandMatcher(scriptFileName)

  for (const event of AUGGIE_EVENTS) {
    const current = Array.isArray(nextHooks[event.eventName]) ? nextHooks[event.eventName] : []
    const cleaned = removeManagedCommands(current, isManagedCommand)
    const definition: HookDefinition = {
      ...(event.needsMatcher ? { matcher: '.*' } : {}),
      hooks: [hook],
      ...(event.metadata ? { metadata: event.metadata } : {})
    }
    nextHooks[event.eventName] = [...cleaned, definition]
  }

  return { ...config, hooks: nextHooks }
}

export function removeManagedHooks(
  config: HooksConfig,
  scriptFileName = getManagedScriptFileName()
): { config: HooksConfig; changed: boolean } {
  const nextHooks = { ...config.hooks }
  const isManagedCommand = createManagedCommandMatcher(scriptFileName)
  let changed = false

  for (const [eventName, definitions] of Object.entries(nextHooks)) {
    if (!Array.isArray(definitions)) {
      continue
    }
    const cleaned = removeManagedCommands(definitions, isManagedCommand)
    if (JSON.stringify(cleaned) !== JSON.stringify(definitions)) {
      changed = true
    }
    if (cleaned.length === 0) {
      delete nextHooks[eventName]
    } else {
      nextHooks[eventName] = cleaned
    }
  }

  return { config: { ...config, hooks: nextHooks }, changed }
}

// Why: presence check mirrors removeManagedCommands' predicate so "is this event covered"
// and "sweep this event's managed entries" never disagree about what counts as managed.
export function hasManagedHookForEvent(
  config: HooksConfig,
  eventName: AuggieEventDefinition['eventName'],
  scriptFileName = getManagedScriptFileName()
): boolean {
  const definitions = config.hooks?.[eventName]
  if (!Array.isArray(definitions)) {
    return false
  }
  const isManagedCommand = createManagedCommandMatcher(scriptFileName)
  return definitions.some((definition) =>
    (definition.hooks ?? []).some((hook) => isManagedCommand(hook.command))
  )
}
