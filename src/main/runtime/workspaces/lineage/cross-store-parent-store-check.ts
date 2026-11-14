import type { CrossStoreParentRef } from '../../../../shared/worktree/lineage-types'
import { RuntimeLineageError } from './runtime-lineage-error'

/** A cross-store parent must name another store; refuses when this store's own identity is unknown. */
export async function assertParentInAnotherStore(
  parent: CrossStoreParentRef,
  readStoreInstallationId: () => Promise<string | undefined>
): Promise<void> {
  const own = await readStoreInstallationId()
  if (!own) {
    throw new RuntimeLineageError(
      'LINEAGE_PARENT_CONTEXT_MISSING',
      "This Orca install's identity is unavailable, so it can't save a parent from another machine."
    )
  }
  if (parent.installationId === own) {
    throw new RuntimeLineageError(
      'LINEAGE_PARENT_CONTEXT_CONFLICT',
      'That parent is in this Orca install. Choose it as a parent here instead.'
    )
  }
}
