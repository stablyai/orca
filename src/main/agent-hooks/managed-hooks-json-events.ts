import { isPlainObject } from './installer-utils'

/** Treat malformed user-edited nodes as absent events when reporting installation status. */
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
