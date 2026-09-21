import { z } from 'zod'
import { salvagedOptional } from '../../../src/shared/zod-salvage'

// Both reads a host's workspace catalog answers. Checked against `worktree.ps` and
// `worktree.listRetiredNames` in src/main/runtime/rpc/methods/worktree-catalog-methods.ts and the
// RuntimeWorktreePsConditionalResult union in src/shared/runtime-worktree-contracts.ts.

/**
 * The catalog envelope, with no member required.
 *
 * `worktrees` cannot be required, and that is the host contract rather than caution: `worktree.ps`
 * answers `RuntimeWorktreePsSnapshotResult` *or* `RuntimeWorktreePsUnchangedResult`, and the second
 * carries `{ unchanged, snapshotId }` and no rows at all. The snapshot client
 * (worktree-catalog-snapshot-client.ts:46) discriminates on `Array.isArray(worktrees)` for exactly
 * that reason, so a schema that demanded rows would refuse every unchanged poll.
 *
 * The rows stay `z.unknown()`. Three screens read this one reply and each projects its own view of
 * a row — the Home card takes `status` and the resume pick, the host screen admits them as
 * `Worktree`, the agent-history panel seeds `scopePaths` — and `RuntimeWorktreePsSummary` has
 * twenty-odd members of which the recorded fixtures carry four. Narrowing the element here would
 * drop a row all three still render.
 *
 * What the schema does prove is that the reply is an object, which is what lets an absent or null
 * result be named at the boundary instead of reaching three different property reads.
 */
export const worktreeCatalogSchema = z.looseObject({
  worktrees: salvagedOptional('worktrees', z.array(z.unknown())),
  snapshotId: salvagedOptional('snapshotId', z.string()),
  unchanged: salvagedOptional('unchanged', z.boolean())
})

/**
 * The retired-name registry, forwarded whole.
 *
 * `readRetiredNameRegistryForRepo` (src/shared/worktree/retired-name-cache.ts:27) is the validator,
 * it is shared with the desktop hook so the two cannot drift on what a failure means, and it takes
 * `unknown` and guards every level — including the "host has never compacted" case where
 * `retiredNameTiersByRepo` is simply absent. Declaring either map here would give one reply two
 * readers that could disagree about a repo. The forward is opaque on purpose, not a member left
 * unchecked.
 */
export const retiredWorktreeNamesSchema = z.unknown()
