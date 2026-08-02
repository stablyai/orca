import type { CommandSpec } from './args'

// Why: validation/help and dispatch use parallel registries that must not drift.

export type RegistryParityGaps = {
  handlersWithoutSpec: string[]
  specsWithoutHandler: string[]
}

export function findRegistryParityGaps(
  specs: CommandSpec[],
  handlerKeys: Iterable<string>
): RegistryParityGaps {
  // Why: aliases resolve before dispatch and deliberately have no handler key.
  const canonical = new Set(specs.map((spec) => spec.path.join(' ')))
  const handlers = new Set(handlerKeys)
  return {
    handlersWithoutSpec: [...handlers].filter((key) => !canonical.has(key)),
    specsWithoutHandler: [...canonical].filter((key) => !handlers.has(key))
  }
}
