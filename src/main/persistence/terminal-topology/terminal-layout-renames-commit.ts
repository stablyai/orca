import { readSessionOperation } from '../loading-store/session-operation'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type {
  CommandOf,
  LayoutRefusalCode
} from '../../../shared/workspace-layout/workspace-layout-command-types'
import type { DurableProfileStateMutation } from '../loading-store/store-runtime-state'
import { applyRenamesToSession } from './terminal-pane-admission'
import { traced, type TerminalTopologyCommitContext } from './terminal-topology-commit'
import { keepFrozen } from './layout-command-commit'
import { writeRestorableSession } from './terminal-topology-membership'

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
      const changes = batches.map(({ hostId, renames }) => ({
        hostId,
        change: applyRenamesToSession(hostId, readSessionOperation(context.state, hostId), renames)
      }))
      const refused = changes.flatMap(({ change }) => change.value)
      const restores = changes.flatMap(({ hostId, change }) =>
        change.session
          ? [
              writeRestorableSession(
                context.state,
                hostId,
                keepFrozen(hostId, change.prepared ?? change.session, context),
                context.markDirty
              )
            ]
          : []
      )
      return restores.length === 0
        ? { value: refused, persist: false }
        : { value: refused, rollback: () => restores.forEach((restore) => restore()) }
    },
    // Per-tab refusals do not reject the remaining write.
    () => undefined
  )
}
