export type CodexRolloutForkLinks = {
  link(rolloutId: string, base: string | null): void
  isReferenced(rolloutId: string): boolean
  baseOf(rolloutId: string): string | null
  /** Drops a deleted rollout; returns the parent it was the last fork of, if any. */
  forget(rolloutId: string): string | null
}

/** Which rollouts read their history prefix from which: a parent is referenced while a fork names it. */
export function createCodexRolloutForkLinks(): CodexRolloutForkLinks {
  const childrenByBase = new Map<string, Set<string>>()
  const baseByChild = new Map<string, string>()
  return {
    link: (rolloutId, base) => {
      if (base === null || base === rolloutId) {
        return
      }
      baseByChild.set(rolloutId, base)
      const children = childrenByBase.get(base) ?? new Set<string>()
      children.add(rolloutId)
      childrenByBase.set(base, children)
    },
    isReferenced: (rolloutId) => (childrenByBase.get(rolloutId)?.size ?? 0) > 0,
    baseOf: (rolloutId) => baseByChild.get(rolloutId) ?? null,
    forget: (rolloutId) => {
      const base = baseByChild.get(rolloutId)
      if (!base) {
        return null
      }
      baseByChild.delete(rolloutId)
      const children = childrenByBase.get(base)
      children?.delete(rolloutId)
      return children?.size === 0 ? base : null
    }
  }
}
