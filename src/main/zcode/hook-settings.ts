import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  buildManagedCommandHook,
  createManagedCommandMatcher,
  getSharedManagedScriptPath,
  hookDefinitionHasManagedCommand,
  isPlainObject,
  removeManagedCommands,
  wrapPosixHookCommand,
  wrapWindowsCmdHookCommand,
  type HookDefinition
} from '../agent-hooks/installer-utils'

const ZCODE_SCRIPT_BASE = 'zcode-hook'

/**
 * Every lifecycle event ZCode's hook runner can fire (`HookEventName` in
 * `packages/contracts/src/hooks/index.ts`). Matchers are omitted on purpose:
 * ZCode's `matchesAnyHookMatcher` treats an absent matcher as "every tool",
 * and Claude's `"*"` is not a valid ZCode matcher.
 */
export const ZCODE_HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'PostToolUseFailure',
  'Stop'
] as const

/**
 * ZCode's hook block, nested one level deeper than Claude's (`hooks.events.<Event>`).
 *
 * `events` is deliberately `unknown`-valued: it comes straight off a user-editable JSON
 * file, so each entry is narrowed by `readEventDefinitions` at the point of use rather
 * than asserted to be well-formed here.
 */
export type ZCodeHooksRuntimeConfig = {
  enabled?: boolean
  events?: Record<string, unknown>
  [key: string]: unknown
}

export type ZCodeConfig = {
  hooks?: ZCodeHooksRuntimeConfig
  [key: string]: unknown
}

export function getZCodeConfigPath(): string {
  // Why: ZCode resolves `~/.zcode/cli` from `homedir()` on every platform
  // (`packages/adapters/src/config/file-config.adapter.ts`) — no APPDATA/XDG branch.
  return join(homedir(), '.zcode', 'cli', 'config.json')
}

export function getZCodeRemoteConfigPath(remoteHome: string): string {
  return `${remoteHome.replace(/\/$/, '')}/.zcode/cli/config.json`
}

export function getZCodeManagedScriptFileName(): string {
  return process.platform === 'win32' ? `${ZCODE_SCRIPT_BASE}.cmd` : `${ZCODE_SCRIPT_BASE}.sh`
}

export function getZCodePosixManagedScriptFileName(): string {
  return `${ZCODE_SCRIPT_BASE}.sh`
}

export function getZCodeManagedScriptPath(): string {
  return getSharedManagedScriptPath(getZCodeManagedScriptFileName())
}

export function getZCodeManagedCommand(scriptPath: string): string {
  if (process.platform === 'win32') {
    // Why: ZCode spawns a `type: "command"` hook through its own shell resolver, so keep the
    // bare directly-spawnable .cmd on the safe path and fall back to the encoded form otherwise.
    return wrapWindowsCmdHookCommand(scriptPath)
  }
  return wrapPosixHookCommand(scriptPath)
}

export function getZCodeRemoteManagedCommand(scriptPath: string): string {
  return wrapPosixHookCommand(scriptPath)
}

function getZCodeManagedCommandMatcher(
  scriptFileName = getZCodeManagedScriptFileName()
): (command: string | undefined) => boolean {
  return createManagedCommandMatcher(scriptFileName)
}

/** The `hooks.events` block as a plain lookup, or empty when absent or malformed. */
export function readZCodeEventMap(config: ZCodeConfig): Record<string, unknown> {
  const events = config.hooks?.events
  return isPlainObject(events) ? events : {}
}

/** The definitions registered for one event, dropping anything not shaped like a list. */
function readEventDefinitions(
  events: Record<string, unknown>,
  eventName: string
): HookDefinition[] {
  const definitions = events[eventName]
  if (!Array.isArray(definitions)) {
    return []
  }
  // Why: a hand-edited config can hold nulls or scalars here; keep only object entries so
  // the callers below never have to re-check, and never throw on user content.
  return definitions.filter((definition): definition is HookDefinition => isPlainObject(definition))
}

export function applyZCodeManagedHooks(
  config: ZCodeConfig,
  command: string,
  scriptFileName = getZCodeManagedScriptFileName()
): ZCodeConfig {
  const nextEvents = { ...readZCodeEventMap(config) }
  const isManagedCommand = getZCodeManagedCommandMatcher(scriptFileName)

  for (const eventName of ZCODE_HOOK_EVENTS) {
    const current = readEventDefinitions(nextEvents, eventName)
    const cleaned = removeManagedCommands(current, isManagedCommand)
    nextEvents[eventName] = [...cleaned, { hooks: [buildManagedCommandHook(command)] }]
  }

  return {
    ...config,
    hooks: {
      ...config.hooks,
      // Why: ZCode's DefaultRuntimeConfig ships `hooks.enabled: false`, so a hook block alone
      // fires nothing — this flag is what the "ZCode hooks never run" reports were missing.
      enabled: true,
      events: nextEvents
    }
  }
}

export function removeZCodeManagedHooks(
  config: ZCodeConfig,
  scriptFileName = getZCodeManagedScriptFileName()
): { config: ZCodeConfig; changed: boolean } {
  const events = readZCodeEventMap(config)
  const nextEvents = { ...events }
  const isManagedCommand = getZCodeManagedCommandMatcher(scriptFileName)
  let changed = false

  for (const [eventName, value] of Object.entries(nextEvents)) {
    // Why: leave a non-array value exactly as the user wrote it — emptying it below would
    // delete a key Orca never owned.
    if (!Array.isArray(value)) {
      continue
    }
    const definitions = readEventDefinitions(nextEvents, eventName)
    const cleaned = removeManagedCommands(definitions, isManagedCommand)
    // Why: only touch an event Orca actually owned something in. Without this, an unrelated
    // empty entry the user wrote (`"Notification": []`) was deleted as collateral whenever a
    // managed hook elsewhere made the write happen.
    if (JSON.stringify(cleaned) === JSON.stringify(definitions)) {
      continue
    }
    changed = true
    if (cleaned.length === 0) {
      delete nextEvents[eventName]
    } else {
      nextEvents[eventName] = cleaned
    }
  }

  if (!changed) {
    return { config, changed: false }
  }
  // Why: leave `hooks.enabled` alone on remove — the user may run their own hooks, and
  // flipping it back to false would silently disable those too.
  return { config: { ...config, hooks: { ...config.hooks, events: nextEvents } }, changed: true }
}

/** Events whose managed command is currently registered in the user's config. */
export function readManagedZCodeHookEvents(
  config: ZCodeConfig,
  scriptFileName = getZCodeManagedScriptFileName()
): Set<string> {
  const isManagedCommand = getZCodeManagedCommandMatcher(scriptFileName)
  const events = readZCodeEventMap(config)
  return new Set(
    ZCODE_HOOK_EVENTS.filter((eventName) =>
      readEventDefinitions(events, eventName).some((definition) =>
        hookDefinitionHasManagedCommand(definition, isManagedCommand)
      )
    )
  )
}

export function isZCodeHooksEnabled(config: ZCodeConfig): boolean {
  return config.hooks?.enabled === true
}
