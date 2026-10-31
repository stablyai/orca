import { reduceStoredPresentationCommand } from '../loading-store/workspace-presentation-command'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type {
  CommandOf,
  LayoutRefusalCode
} from '../../../shared/workspace-layout/workspace-layout-command-types'
import type { DurableProfileStateMutation } from '../loading-store/store-runtime-state'
import { writeRestorable } from './restorable-write'
import { applyRenamesToSession } from './terminal-pane-admission'
import { traced, type TerminalTopologyCommitContext } from './terminal-topology-commit'
import { keepFrozen } from './layout-command-commit'
import { assignWorkspaceSessionPartition } from './terminal-topology-membership'

/** Publish routed tab renames in one frame and return per-tab refusals. */
export function applyLayoutRenames(
  batches: readonly { hostId: ExecutionHostId; renames: readonly CommandOf<'renameTab'>[] }[],
  context: TerminalTopologyCommitContext
): () => DurableProfileStateMutation<
  { rename: CommandOf<'renameTab'>; code: LayoutRefusalCode }[]
> {
  return traced(
    'apply_layout',
    () => {
      const refused: { rename: CommandOf<'renameTab'>; code: LayoutRefusalCode }[] = []
      let presentationChanged = false
      const changes = batches.map(({ hostId, renames }) => {
        const raw = renames.filter((rename) => {
          const outcome = reduceStoredPresentationCommand(context.state, rename)
          if (!outcome) {
            return true
          }
          if (!outcome.ok) {
            refused.push({ rename, code: outcome.code })
          } else {
            presentationChanged = true
          }
          return false
        })
        return { hostId, change: applyRenamesToSession(hostId, context.getSession(hostId), raw) }
      })
      refused.push(...changes.flatMap(({ change }) => change.value))
      const restores = changes.flatMap(({ hostId, change }) =>
        change.session
          ? [
              writeRestorable(
                () => context.getSession(hostId),
                (value) =>
                  context.markDirty(assignWorkspaceSessionPartition(context.state, hostId, value)),
                keepFrozen(hostId, change.session, context)
              )
            ]
          : []
      )
      return restores.length === 0 && !presentationChanged
        ? { value: refused, persist: false }
        : { value: refused, rollback: () => restores.forEach((restore) => restore()) }
    },
    // Per-tab refusals do not reject the remaining write.
    () => undefined
  )
}
