/**
 * Which repos a fresh inventory must list completely: `repoId` (or every local repo) for `true`,
 * exactly the listed repos for a list, none for `false`.
 */
export function freshInventoryScope(
  freshInventory: boolean | readonly string[],
  repoId: string | undefined
): string | null | ReadonlySet<string> | undefined {
  if (Array.isArray(freshInventory)) {
    return new Set(freshInventory)
  }
  return freshInventory ? (repoId ?? null) : undefined
}
