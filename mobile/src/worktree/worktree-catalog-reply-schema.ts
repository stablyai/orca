import { z } from 'zod'
import { salvagedOptional } from '../../../src/shared/zod-salvage'

// Accept unchanged polls without worktrees; consumers validate their own row projections.
// Require only an object envelope so null/absent results fail at the boundary.
export const worktreeCatalogSchema = z.looseObject({
  worktrees: salvagedOptional('worktrees', z.array(z.unknown())),
  snapshotId: salvagedOptional('snapshotId', z.string()),
  unchanged: salvagedOptional('unchanged', z.boolean())
})

// Forward opaque registry data to readRetiredNameRegistryForRepo, the shared desktop/mobile validator.
// A second map reader here could disagree about absent or malformed repo entries.
export const retiredWorktreeNamesSchema = z.unknown()
