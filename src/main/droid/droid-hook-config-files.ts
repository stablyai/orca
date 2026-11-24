import { join } from 'node:path'
import { parse as parseJsonc, type ParseError } from 'jsonc-parser'
import type { SFTPWrapper } from 'ssh2'
import { buildManagedCommandHook } from '../agent-hooks/installation/configuration/hook-config-schema'
import {
  createManagedCommandMatcher,
  hookDefinitionHasManagedCommand,
  removeManagedCommands
} from '../agent-hooks/installation/commands/managed-hook-command-matching'
import {
  isPlainObject,
  parseHooksJsonText,
  readHooksJsonWithRaw,
  type HooksJsonSnapshot
} from '../agent-hooks/installation/configuration/hooks-json-read'
import { readTextFileRemote } from '../agent-hooks/installation/remote/hook-text-files-remote'

// SessionStart clears prompt/tool caches on resume before the next user prompt.
export const DROID_EVENTS = [
  { eventName: 'SessionStart', definition: {} },
  { eventName: 'UserPromptSubmit', definition: {} },
  { eventName: 'Stop', definition: {} },
  // SubagentStop reports mission progress; the listener must not treat it as parent completion.
  { eventName: 'SubagentStop', definition: {} },
  { eventName: 'PreToolUse', definition: { matcher: '*' } },
  { eventName: 'PostToolUse', definition: { matcher: '*' } },
  // Droid has no PermissionRequest hook event; approval waits come from PreToolUse and Notification.
  { eventName: 'Notification', definition: {} }
] as const

/** Droid's hook map: hooks.json holds it at the top level, settings.json under its `hooks` key. */
export type DroidHookEvents = Record<string, unknown>

/** Orca rewrites only plain-JSON files, so a JSONC or unreadable file is never clobbered. */
export type DroidHooksFile = { path: string; events: DroidHookEvents; editable: boolean }

/**
 * Strips Orca's entries from every event, then adds them back when a command is given. Null means
 * nothing changed, so the file must not be rewritten.
 *
 * A hooks-file event replaces the same settings.json event in Droid, so Orca joins the hooks file
 * only for events it already defines (a new key would hide the user's settings.json hooks), and an
 * event emptied there stays `[]` so it keeps hiding what it hid before.
 */
export function nextDroidHookEvents(
  events: unknown,
  scriptFileName: string,
  command: string | null,
  file: 'settings' | 'hooks'
): DroidHookEvents | null {
  if (!isPlainObject(events) && command === null) {
    return null
  }
  const current: DroidHookEvents = isPlainObject(events) ? events : {}
  const isManagedCommand = createManagedCommandMatcher(scriptFileName)
  const next: DroidHookEvents = { ...current }
  for (const [eventName, definitions] of Object.entries(current)) {
    if (!Array.isArray(definitions)) {
      continue
    }
    const cleaned = removeManagedCommands(definitions, isManagedCommand)
    if (file === 'settings' && cleaned.length === 0 && definitions.length > 0) {
      delete next[eventName]
    } else {
      next[eventName] = cleaned
    }
  }
  if (command !== null) {
    for (const event of DROID_EVENTS) {
      if (file === 'hooks' && !Array.isArray(current[event.eventName])) {
        continue
      }
      const kept = next[event.eventName]
      const definition = { ...event.definition, hooks: [buildManagedCommandHook(command)] }
      next[event.eventName] = [...(Array.isArray(kept) ? kept : []), definition]
    }
  }
  return JSON.stringify(next) === JSON.stringify(events) ? null : next
}

export function hasManagedDroidHooks(events: unknown, scriptFileName: string): boolean {
  if (!isPlainObject(events)) {
    return false
  }
  const isManagedCommand = createManagedCommandMatcher(scriptFileName)
  return Object.values(events).some(
    (definitions) =>
      Array.isArray(definitions) &&
      definitions.some((definition) =>
        hookDefinitionHasManagedCommand(definition, isManagedCommand)
      )
  )
}

// Droid parses the hooks file as JSONC and ignores it on any parse error or read failure.
function parseDroidHooksFile(path: string, raw: string | null): DroidHooksFile {
  const json = raw === null ? null : parseHooksJsonText(raw)
  if (json) {
    return { path, events: json, editable: true }
  }
  const errors: ParseError[] = []
  const parsed: unknown = raw === null ? undefined : parseJsonc(raw.replace(/^\uFEFF/, ''), errors)
  return {
    path,
    events: errors.length === 0 && isPlainObject(parsed) ? parsed : {},
    editable: false
  }
}

function isAbsent(snapshot: HooksJsonSnapshot): boolean {
  return snapshot.raw === null && snapshot.config !== null
}

// Droid reads the legacy hooks/hooks.json only while hooks.json is absent, so Orca edits whichever
// one Droid loads.
export function readDroidHooksFile(factoryDir: string): DroidHooksFile {
  const path = join(factoryDir, 'hooks.json')
  const current = readHooksJsonWithRaw(path)
  if (!isAbsent(current)) {
    return parseDroidHooksFile(path, current.raw)
  }
  const legacyPath = join(factoryDir, 'hooks', 'hooks.json')
  const legacy = readHooksJsonWithRaw(legacyPath)
  return isAbsent(legacy)
    ? { path, events: {}, editable: true }
    : parseDroidHooksFile(legacyPath, legacy.raw)
}

// Null means the file is absent. Like a local read failure, an unreadable file is left untouched.
async function readRemoteHooksFile(
  sftp: SFTPWrapper,
  path: string
): Promise<DroidHooksFile | null> {
  try {
    const body = await readTextFileRemote(sftp, path)
    return body === null ? null : parseDroidHooksFile(path, body)
  } catch {
    return parseDroidHooksFile(path, null)
  }
}

export async function readDroidHooksFileRemote(
  sftp: SFTPWrapper,
  factoryDir: string
): Promise<DroidHooksFile> {
  const path = `${factoryDir}/hooks.json`
  return (
    (await readRemoteHooksFile(sftp, path)) ??
    (await readRemoteHooksFile(sftp, `${factoryDir}/hooks/hooks.json`)) ?? {
      path,
      events: {},
      editable: true
    }
  )
}
