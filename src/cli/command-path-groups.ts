import { specPaths, type CommandSpec } from './command-spec'

function isStrictPrefix(prefix: string[], path: readonly string[]): boolean {
  return path.length > prefix.length && prefix.every((segment, index) => path[index] === segment)
}

/**
 * Any exact prefix of a registered command path is a help-only group, so nested
 * namespaces such as `linear project` and `linear project update` are
 * discoverable without hard-coding each one.
 */
export function isCommandPathGroup(specs: CommandSpec[], commandPath: string[]): boolean {
  if (commandPath.length === 0) {
    return false
  }
  return specs.some((spec) => specPaths(spec).some((path) => isStrictPrefix(commandPath, path)))
}

/** Canonical specs nested under a group, in registration order. */
export function commandPathGroupSpecs(specs: CommandSpec[], group: string[]): CommandSpec[] {
  return specs.filter((spec) => isStrictPrefix(group, spec.path))
}
