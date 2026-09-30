import { isPlainObject } from './installer-utils'

/**
 * Which of `events` an Orca-owned `{ hooks: { <event>: [{ hooks: [{ command }] }] } }` file
 * still registers under a managed command.
 *
 * Shared by every agent whose managed hooks file Orca generates wholesale (Muse, DSH), so
 * "installed", "partial" and "not_installed" cannot drift between them.
 *
 * Why every lookup is guarded: the file is on disk and hand-editable, so any node can be
 * null, a scalar, or the wrong container. A malformed node reads as "event absent" — status
 * calculation must report a broken install, never throw on it.
 */
export function readManagedHookEventsFromJson(
  parsed: unknown,
  events: readonly string[],
  isManagedCommand: (command: string | undefined) => boolean
): Set<string> {
  const hooks = isPlainObject(parsed) && isPlainObject(parsed.hooks) ? parsed.hooks : {}
  return new Set(
    events.filter((event) =>
      asArray(hooks[event]).some((definition) =>
        asArray(isPlainObject(definition) ? definition.hooks : null).some((hook) =>
          isManagedCommand(readCommand(hook))
        )
      )
    )
  )
}

function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : []
}

function readCommand(hook: unknown): string | undefined {
  const command = isPlainObject(hook) ? hook.command : undefined
  return typeof command === 'string' ? command : undefined
}
