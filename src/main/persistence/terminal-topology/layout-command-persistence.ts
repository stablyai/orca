import type {
  CommandOf,
  LayoutApplyOutcome,
  LayoutCommand
} from '../../../shared/workspace-layout/workspace-layout-command-types'
import {
  resolveHostId,
  type SessionHostPartitionOperations
} from '../loading-store/session-host-partitions'
import type { StoreRuntimeState } from '../loading-store/store-runtime-state'
import { applyLayout, keepFrozen, topologyCommitContext } from './terminal-topology-commit'
import { moveTabAcrossPartitions } from './cross-partition-tab-move'
import { writeRestorable } from './restorable-write'
import { assignWorkspaceSessionPartition } from './terminal-topology-membership'
import {
  repairDuplicatePtyPanesMutation,
  type DuplicatePtyPaneTransfer
} from './duplicate-pty-pane-repair'

type LayoutCommandRuntime = Pick<
  StoreRuntimeState,
  'runDurableMutation' | 'state' | 'dirtyProfileStateDomains' | 'writesFrozen'
>

const layoutCommandPersistenceContext = Symbol('LayoutCommandPersistence')
type LayoutCommandPersistenceContext = {
  runtime: LayoutCommandRuntime
  sessions: SessionHostPartitionOperations
}

/** The Store's half of `layout.apply`; the commit module owns the write. */
export class LayoutCommandPersistence {
  readonly [layoutCommandPersistenceContext]: LayoutCommandPersistenceContext

  constructor(runtime: LayoutCommandRuntime, sessions: SessionHostPartitionOperations) {
    this[layoutCommandPersistenceContext] = { runtime, sessions }
  }

  /** Applies to each partition holding the command's tab, routed partition first (local if none). */
  applyLayoutCommand(
    command: LayoutCommand,
    hostIds: readonly string[] = []
  ): Promise<LayoutApplyOutcome> {
    const context = this[layoutCommandPersistenceContext]
    const resolved = hostIds.length > 0 ? hostIds.map(resolveHostId) : [resolveHostId()]
    return context.runtime.runDurableMutation(
      applyLayout(resolved, command, topologyCommitContext(context))
    )
  }

  /** Moves editor tabs between workspaces of two partitions in one durable write of both. */
  moveTabToWorkspaceAcrossPartitions(
    command: CommandOf<'moveTabToWorkspace'>,
    fromHostId: string,
    toHostId: string
  ): Promise<LayoutApplyOutcome> {
    const commit = topologyCommitContext(this[layoutCommandPersistenceContext])
    const [from, to] = [resolveHostId(fromHostId), resolveHostId(toHostId)]
    return this[layoutCommandPersistenceContext].runtime.runDurableMutation(() => {
      const moved = moveTabAcrossPartitions(
        { hostId: from, session: commit.getSession(from) },
        { hostId: to, session: commit.getSession(to) },
        command
      )
      if (!moved.sessions) {
        return { value: moved.value, persist: false }
      }
      const restores = (
        [
          [from, moved.sessions.from],
          [to, moved.sessions.to]
        ] as const
      ).map(([hostId, session]) =>
        writeRestorable(
          () => commit.getSession(hostId),
          (value) => commit.markDirty(assignWorkspaceSessionPartition(commit.state, hostId, value)),
          keepFrozen(hostId, session, commit)
        )
      )
      return { value: moved.value, rollback: () => restores.forEach((restore) => restore()) }
    })
  }

  /**
   * Layout-owner builds, once a runtime starts: one pane per terminal on disk, written only after
   * `transfer` moved each dropped pane's owners. Resolves the number of partitions repaired.
   */
  repairDuplicatePtyPanes(transfer: (move: DuplicatePtyPaneTransfer) => boolean): Promise<number> {
    const context = this[layoutCommandPersistenceContext]
    // An imported or frozen profile neither writes nor moves owners.
    if (context.runtime.writesFrozen) {
      return Promise.resolve(0)
    }
    return context.runtime.runDurableMutation(
      repairDuplicatePtyPanesMutation(topologyCommitContext(context), transfer)
    )
  }
}
