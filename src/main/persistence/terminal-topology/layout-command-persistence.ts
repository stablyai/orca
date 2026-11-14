import { publishTerminalTopologyPartition } from './pane-ownership/terminal-topology-membership'
import type { LayoutClientVisibility } from '../../../shared/workspace-layout/client-views/workspace-layout-client-visibility'
import type { WorkspaceSessionState } from '../../../shared/workspace-session/workspace-session-state-types'
import type {
  CommandOf,
  LayoutApplyOutcome,
  LayoutCommand,
  LayoutEffects,
  LayoutRefusalCode
} from '../../../shared/workspace-layout/workspace-layout-command-types'
import type { LayoutLiveContext } from './pane-admission/terminal-pane-admission'
import {
  resolveHostId,
  type SessionHostPartitionOperations
} from '../loading-store/workspace-sessions/session-host-partitions'
import type {
  DurableProfileStateMutation,
  StoreRuntimeState
} from '../loading-store/store-runtime-state'
import type { ExecutionHostId } from '../../../shared/execution-host'
import {
  applyLayout,
  applyEditorFileRenamesInPartitions,
  topologyCommitContext
} from './terminal-topology-commit'
import { keepFrozen } from './command-application/layout-command-commit'
import { applyLayoutRenames } from './command-application/terminal-layout-renames-commit'
import {
  isTerminalClose,
  keptOnWriteFailure
} from './command-application/terminal-close-write-failure'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../shared/layout-owner-switch'
import { moveTabAcrossPartitions } from './pane-moves/cross-partition-tab-move'
import { writeRestorable } from './command-application/restorable-write'
import {
  keepPartitionEditorViews,
  partitionEditorViewsOf
} from '../loading-store/workspace-sessions/layout-editor-views'
import {
  repairDuplicatePtyPanesMutation,
  type DuplicatePtyPaneTransfer
} from './pane-ownership/duplicate-pty-pane-repair'

/** Scope publication so readers reload only changed partitions. */
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
  | 'ptyBindingGenerationSequence'
  | 'layoutEditorViews'
>

const layoutCommandPersistenceContext = Symbol('LayoutCommandPersistence')
type LayoutCommandPersistenceContext = {
  runtime: LayoutCommandRuntime
  sessions: SessionHostPartitionOperations
  /** Retry failed profile writes later in layout-owner builds. */
  writeLater?: () => void
}

export class LayoutCommandPersistence {
  readonly [layoutCommandPersistenceContext]: LayoutCommandPersistenceContext

  constructor(
    runtime: LayoutCommandRuntime,
    sessions: SessionHostPartitionOperations,
    writeLater?: () => void
  ) {
    this[layoutCommandPersistenceContext] = { runtime, sessions, writeLater }
  }

  /** Apply to every holder, routed first (local fallback); report routed effects only through onEffects. */
  applyLayoutCommand(
    command: LayoutCommand,
    hostIds: readonly string[] = [],
    run: {
      admit?: (partitions?: readonly WorkspaceSessionState[]) => boolean
      live?: LayoutLiveContext
      visibility?: LayoutClientVisibility
      stopBeforeWrite?: (ptyIds: readonly string[]) => boolean
      onEffects?: (effects: LayoutEffects) => void
    } = {}
  ): Promise<LayoutApplyOutcome> {
    const context = this[layoutCommandPersistenceContext]
    const resolved = hostIds.length > 0 ? hostIds.map(resolveHostId) : [resolveHostId()]
    let effects: LayoutEffects | undefined
    const commit = applyLayout(resolved, command, topologyCommitContext(context), {
      live: { ...run.live, visibility: run.visibility },
      stopBeforeWrite: run.stopBeforeWrite,
      noteEffects: (noted) => (effects = noted)
    })
    const admitted = (): DurableProfileStateMutation<LayoutApplyOutcome> =>
      run.admit &&
      !run.admit(resolved.map((hostId) => context.sessions.getWorkspaceSession(hostId)))
        ? { value: { ok: false, code: 'tab_not_found' }, persist: false }
        : commit()
    // Applied closes must stay closed even when persistence fails.
    const applied: Promise<LayoutApplyOutcome> =
      ORCA_LAYOUT_OWNER_IS_MAIN && context.writeLater && isTerminalClose(command)
        ? keptOnWriteFailure(
            (mutate) => context.runtime.runDurableMutation(mutate),
            writingOnly(resolved, admitted),
            context.writeLater
          )
        : context.runtime.runDurableMutation(writingOnly(resolved, admitted))
    if (!run.onEffects) {
      return applied
    }
    return applied.then((outcome) => {
      if (outcome.ok && effects) {
        run.onEffects?.(effects)
      }
      return outcome
    })
  }

  /** Atomically rename across partitions; no panes change, so binding generations/fences stay put. */
  applyEditorFileRenamesAcrossPartitions(
    batches: readonly { hostId: string; command: CommandOf<'renameEditorFiles'> }[]
  ): Promise<LayoutApplyOutcome> {
    const context = this[layoutCommandPersistenceContext]
    const resolved = batches.map(({ hostId, command }) => ({
      hostId: resolveHostId(hostId),
      command
    }))
    return context.runtime.runDurableMutation(
      writingOnly(
        resolved.map(({ hostId }) => hostId),
        applyEditorFileRenamesInPartitions(resolved, topologyCommitContext(context))
      )
    )
  }

  /** Persist partition renames together and return per-tab refusals. */
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

  moveTabToWorkspaceAcrossPartitions(
    command: CommandOf<'moveTabToWorkspace'>,
    fromHostId: string,
    toHostId: string,
    run?: { visibility?: LayoutClientVisibility }
  ): Promise<LayoutApplyOutcome> {
    const commit = topologyCommitContext(this[layoutCommandPersistenceContext])
    const [from, to] = [resolveHostId(fromHostId), resolveHostId(toHostId)]
    const { runtime } = this[layoutCommandPersistenceContext]
    return runtime.runDurableMutation(() => {
      const moved = moveTabAcrossPartitions(
        {
          hostId: from,
          session: commit.getSession(from),
          views: partitionEditorViewsOf(runtime, from)
        },
        { hostId: to, session: commit.getSession(to), views: partitionEditorViewsOf(runtime, to) },
        command,
        run?.visibility
      )
      if (!moved.sessions) {
        return { value: moved.value, persist: false }
      }
      const viewRestores = moved.views
        ? [
            keepPartitionEditorViews(runtime, from, moved.views.from),
            keepPartitionEditorViews(runtime, to, moved.views.to)
          ]
        : []
      const sessionRestores = (
        [
          [from, moved.sessions.from],
          [to, moved.sessions.to]
        ] as const
      ).map(([hostId, session]) =>
        writeRestorable(
          () => commit.getSession(hostId),
          (value) => publishTerminalTopologyPartition(commit, hostId, value),
          keepFrozen(hostId, session, commit)
        )
      )
      const restores = [...viewRestores, ...sessionRestores]
      return { value: moved.value, rollback: () => restores.forEach((restore) => restore()) }
    })
  }

  /** Runtime-only repair: transfer pane owners before persisting one-pane-per-terminal layouts. */
  repairDuplicatePtyPanes(transfer: (move: DuplicatePtyPaneTransfer) => boolean): Promise<number> {
    const context = this[layoutCommandPersistenceContext]
    // Frozen/imported profiles cannot write or transfer owners.
    if (context.runtime.writesFrozen) {
      return Promise.resolve(0)
    }
    return context.runtime.runDurableMutation(
      repairDuplicatePtyPanesMutation(topologyCommitContext(context), transfer)
    )
  }
}
