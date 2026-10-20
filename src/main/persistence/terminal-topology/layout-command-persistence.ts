import type {
  CommandOf,
  LayoutApplyOutcome,
  LayoutCommand,
  LayoutRefusalCode
} from '../../../shared/workspace-layout/workspace-layout-command-types'
import {
  resolveHostId,
  type SessionHostPartitionOperations
} from '../loading-store/session-host-partitions'
import type {
  DurableProfileStateMutation,
  StoreRuntimeState
} from '../loading-store/store-runtime-state'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { applyLayout, keepFrozen, topologyCommitContext } from './terminal-topology-commit'
import { applyLayoutRenames } from './terminal-layout-renames-commit'
import { isTerminalClose, keptOnWriteFailure } from './terminal-close-write-failure'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../shared/layout-owner-switch'
import { moveTabAcrossPartitions } from './cross-partition-tab-move'
import { writeRestorable } from './restorable-write'
import { raisingBindingGenerations } from './layout-command-binding-generations'
import { assignWorkspaceSessionPartition } from './terminal-topology-membership'
import {
  repairDuplicatePtyPanesMutation,
  type DuplicatePtyPaneTransfer
} from './duplicate-pty-pane-repair'

/** A commit that writes only these partitions says so, so readers re-read just those. */
function writingOnly<T>(
  hostIds: readonly ExecutionHostId[],
  mutate: () => DurableProfileStateMutation<T>
): () => DurableProfileStateMutation<T> {
  return () => ({ ...mutate(), writtenHostIds: hostIds })
}

type LayoutCommandRuntime = Pick<
  StoreRuntimeState,
  | 'runDurableMutation'
  | 'state'
  | 'dirtyProfileStateDomains'
  | 'writesFrozen'
  | 'ptyBindingGenerations'
>

const layoutCommandPersistenceContext = Symbol('LayoutCommandPersistence')
type LayoutCommandPersistenceContext = {
  runtime: LayoutCommandRuntime
  sessions: SessionHostPartitionOperations
  /** Layout-owner build: saves the profile again later, after a write that failed. */
  writeLater?: () => void
}

/** The Store's half of `layout.apply`; the commit module owns the write. */
export class LayoutCommandPersistence {
  readonly [layoutCommandPersistenceContext]: LayoutCommandPersistenceContext

  constructor(
    runtime: LayoutCommandRuntime,
    sessions: SessionHostPartitionOperations,
    writeLater?: () => void
  ) {
    this[layoutCommandPersistenceContext] = { runtime, sessions, writeLater }
  }

  /** Applies to each partition holding the command's tab, routed partition first (local if none). */
  applyLayoutCommand(
    command: LayoutCommand,
    hostIds: readonly string[] = []
  ): Promise<LayoutApplyOutcome> {
    const context = this[layoutCommandPersistenceContext]
    const resolved = hostIds.length > 0 ? hostIds.map(resolveHostId) : [resolveHostId()]
    const commit = raisingBindingGenerations(
      context.runtime,
      resolved,
      (hostId) => context.sessions.getWorkspaceSession(hostId),
      applyLayout(resolved, command, topologyCommitContext(context))
    )
    // Switch point: a terminal close stands once applied, as the switch-off window shows it.
    if (ORCA_LAYOUT_OWNER_IS_MAIN && context.writeLater && isTerminalClose(command)) {
      return keptOnWriteFailure(
        (mutate) => context.runtime.runDurableMutation(mutate),
        writingOnly(resolved, commit),
        context.writeLater
      )
    }
    return context.runtime.runDurableMutation(writingOnly(resolved, commit))
  }

  /** `renameTabs`: each partition's renames in one durable write of all; resolves those refused. */
  applyTabRenames(
    batches: readonly { hostId: string; renames: readonly CommandOf<'renameTab'>[] }[]
  ): Promise<{ rename: CommandOf<'renameTab'>; code: LayoutRefusalCode }[]> {
    const context = this[layoutCommandPersistenceContext]
    const resolved = batches.map(({ hostId, renames }) => ({
      hostId: resolveHostId(hostId),
      renames
    }))
    return context.runtime.runDurableMutation(
      writingOnly(
        resolved.map(({ hostId }) => hostId),
        applyLayoutRenames(resolved, topologyCommitContext(context))
      )
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
