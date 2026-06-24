import type { CommandSpec } from './args'

// Why: specs (validation/help) and handlers (dispatch) are two parallel
// registries. Nothing structurally prevents a handler without a spec, or a spec
// without a handler. This guard makes that drift a build failure.

export type RegistryParityGaps = {
  handlersWithoutSpec: string[]
  specsWithoutHandler: string[]
}

export function findRegistryParityGaps(
  specs: CommandSpec[],
  handlerKeys: Iterable<string>
): RegistryParityGaps {
  // Why: alias paths are deliberately NOT canonical spec paths and never get a
  // dedicated handler — they resolve to the canonical path before dispatch. So
  // parity is checked against canonical paths only; aliases are naturally exempt.
  const canonical = new Set(specs.map((spec) => spec.path.join(' ')))
  const handlers = new Set(handlerKeys)
  return {
    handlersWithoutSpec: [...handlers].filter((key) => !canonical.has(key)),
    specsWithoutHandler: [...canonical].filter((key) => !handlers.has(key))
  }
}
