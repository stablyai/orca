import {
  buildManagedCommandHook,
  removeManagedCommands,
  type HookDefinition
} from '../agent-hooks/installer-utils'

/**
 * Reconciles Orca's managed hook command into an event's definition list,
 * reusing the existing slot when possible so positional trust keys survive.
 */
export function reconcileManagedHookDefinition(
  current: HookDefinition[],
  isManagedCommand: (command: string | undefined) => boolean,
  command: string
): { definitions: HookDefinition[]; groupIndex: number; handlerIndex: number } {
  const directCommandKeys = ['command', 'bash', 'powershell'] as const
  const hasManagedDirectCommand = current.some((definition) =>
    directCommandKeys.some((key) => isManagedCommand(definition[key]))
  )
  const nestedLocations = current.flatMap((definition, groupIndex) =>
    Array.isArray(definition.hooks)
      ? definition.hooks.flatMap((hook, handlerIndex) =>
          isManagedCommand(hook.command) ? [{ groupIndex, handlerIndex }] : []
        )
      : []
  )
  if (!hasManagedDirectCommand && nestedLocations.length === 1) {
    const { groupIndex, handlerIndex } = nestedLocations[0]!
    const definition = current[groupIndex]!
    const hasDirectCommand = directCommandKeys.some((key) => typeof definition[key] === 'string')
    if (definition.matcher === undefined && !hasDirectCommand) {
      const definitions = [...current]
      // Why: users can append groups or handlers after Orca's first install.
      // Reusing the exact slot preserves all later positional trust keys.
      const hooks = [...definition.hooks!]
      hooks[handlerIndex] = buildManagedCommandHook(command)
      definitions[groupIndex] = { ...definition, hooks }
      return { definitions, groupIndex, handlerIndex }
    }
  }

  const cleaned = removeManagedCommands(current, isManagedCommand)
  // Why: first install appends LAST so no existing user trust position shifts.
  return {
    definitions: [...cleaned, { hooks: [buildManagedCommandHook(command)] }],
    groupIndex: cleaned.length,
    handlerIndex: 0
  }
}
