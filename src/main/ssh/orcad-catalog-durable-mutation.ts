import type { OrcadMigrationCatalogState } from '../../shared/orcad-migration-manifest'

export async function resolveDurableOrcadCatalogMutation(
  mutate: () => Promise<OrcadMigrationCatalogState>,
  read: () => Promise<OrcadMigrationCatalogState>,
  accepted: (state: OrcadMigrationCatalogState) => boolean
) {
  try {
    return await mutate()
  } catch (mutationError) {
    let observed: OrcadMigrationCatalogState
    try {
      observed = await read()
    } catch {
      throw mutationError
    }
    if (!accepted(observed)) {
      throw mutationError
    }
  }
  // State reads may reflect unflushed mutations; an idempotent acknowledgment proves durability.
  return mutate()
}
