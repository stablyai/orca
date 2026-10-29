import { runSessionOperation } from './session-operation'
import { LOCAL_EXECUTION_HOST_ID, parseExecutionHostId } from '../../../shared/execution-host'
import { makePaneKey } from '../../../shared/stable-pane-id'

import type { StoreRuntimeState } from './store-runtime-state'
import { resolveHostId, type SessionHostPartitionOperations } from './session-host-partitions'
import {
  withdrawUnstartedPane,
  type UnstartedPaneKept
} from '../terminal-topology/unstarted-pane-withdraw'
import { evaluatePtyBindingFastLane } from './pty-binding-fast-lane'
import { durabilityOnlyBindingResult, isDurabilityOnlyMatch } from './pty-binding-durability-only'
import { ptyBindingIsRefused } from './pty-binding-refusals'
import {
  reportPtyBindingOwnerConflict,
  reportPtyBindingPlacement,
  startPtyBindingSpan,
  type PtyBindingSpan
} from './pty-binding-span'
import type {
  TerminalLeafMoveRequest,
  TerminalLeafMoveResult
} from '../../../shared/terminal-leaf-move'
import {
  admitPane,
  moveLeaf,
  topologyCommitContext,
  withdrawPane,
  type TerminalTopologyCommitContext
} from '../terminal-topology/terminal-topology-commit'
import type {
  TerminalPaneAdmission,
  TerminalPaneAdmissionOutcome
} from '../terminal-topology/terminal-pane-admission'
import type {
  CommandOf,
  LayoutRefusalCode
} from '../../../shared/workspace-layout/workspace-layout-command-types'
import { bumpPtyBindingGeneration } from './pty-binding-generations'

type PtyBindingPersistenceOperationsRuntime = Pick<
  StoreRuntimeState,
  | 'runDurableMutation'
  | 'lastDurableWriteGeneration'
  | 'pendingWrite'
  | 'quitFlushStarted'
  | 'dirtyProfileStateDomains'
  | 'state'
  | 'writeGeneration'
  | 'writeTimer'
  | 'ptyBindingGenerations'
>

function markPtyBindingSessionDirty(
  runtime: Pick<StoreRuntimeState, 'dirtyProfileStateDomains'>,
  hostId: ReturnType<typeof resolveHostId>
): void {
  runtime.dirtyProfileStateDomains?.add(
    hostId === LOCAL_EXECUTION_HOST_ID ? 'workspaceSession' : 'workspaceSessionsByHostId'
  )
}

export type { PersistPtyBindingArgs } from './pty-binding-args'
import type { PersistPtyBindingArgs } from './pty-binding-args'

const ptyBindingPersistenceOperationsContext = Symbol('PtyBindingPersistenceOperations')
type PtyBindingPersistenceOperationsContext = {
  runtime: PtyBindingPersistenceOperationsRuntime
  sessions: SessionHostPartitionOperations
}

export class PtyBindingPersistenceOperations {
  readonly [ptyBindingPersistenceOperationsContext]: PtyBindingPersistenceOperationsContext

  constructor(
    runtime: PtyBindingPersistenceOperationsRuntime,
    sessions: SessionHostPartitionOperations
  ) {
    this[ptyBindingPersistenceOperationsContext] = { runtime, sessions }
  }

  /** Preserve the pane while clearing its dead binding; an incarnation fence narrows absence evidence. */
  async retirePtyBinding(
    binding: Pick<PersistPtyBindingArgs, 'worktreeId' | 'tabId' | 'leafId' | 'ptyId'>,
    hostId?: string | null,
    fence?: { incarnationId: string | undefined }
  ): Promise<boolean> {
    const { runtime, sessions } = this[ptyBindingPersistenceOperationsContext]
    const resolved = resolveHostId(hostId)
    return runtime.runDurableMutation(() => {
      const session = sessions.getWorkspaceSession(resolved)
      const currentId =
        session.terminalLayoutsByTabId[binding.tabId]?.ptyIdsByLeafId?.[binding.leafId]
      if (!currentId) {
        return { value: true, persist: 'if-dirty' }
      }
      if (currentId !== binding.ptyId) {
        return { value: false, persist: false }
      }
      if (
        fence &&
        session.terminalPtyIncarnationsByPaneKey?.[makePaneKey(binding.tabId, binding.leafId)] !==
          fence.incarnationId
      ) {
        return { value: false, persist: false }
      }
      if (!session.tabsByWorktree[binding.worktreeId]?.some((tab) => tab.id === binding.tabId)) {
        return { value: false, persist: false }
      }
      const staged = runSessionOperation(runtime.state, resolved, {
        type: 'retirePty',
        owner: binding.worktreeId,
        ...binding
      })
      markPtyBindingSessionDirty(runtime, resolved)
      bumpPtyBindingGeneration(runtime, resolved, binding.leafId)
      return {
        value: true,
        writtenHostIds: [resolved],
        rollback: () => {
          runSessionOperation(runtime.state, resolved, { type: 'rollbackPty', staged })
          markPtyBindingSessionDirty(runtime, resolved)
          bumpPtyBindingGeneration(runtime, resolved, binding.leafId)
        }
      }
    })
  }

  async persistPtyBinding(
    input: PersistPtyBindingArgs | (() => PersistPtyBindingArgs | null),
    hostId?: string | null
  ): Promise<boolean> {
    const { runtime, sessions } = this[ptyBindingPersistenceOperationsContext]
    const resolvedHostId = resolveHostId(hostId)
    const savePending = runtime.writeTimer !== null || runtime.pendingWrite !== null
    let span: PtyBindingSpan | undefined
    let outcome: 'refused' | 'fast_lane' | 'flushed' = 'flushed'
    try {
      const persisted = await runtime.runDurableMutation(() => {
        const args = typeof input === 'function' ? input() : input
        if (!args) {
          return { value: false, persist: false }
        }
        // Measure admitted execution after queue wait, before current-state checks.
        span = startPtyBindingSpan({
          hostKind: parseExecutionHostId(resolvedHostId)?.kind ?? 'local',
          origin: args.origin ?? 'unknown',
          savePending,
          generationGap: runtime.writeGeneration - runtime.lastDurableWriteGeneration
        })
        const paneKey = `${args.tabId}:${args.leafId}`
        const bindingWorktreeId = args.expectedSourceBinding?.worktreeId ?? args.worktreeId
        const session = sessions.getWorkspaceSession(resolvedHostId)
        const partitions = sessions
          .getWorkspaceSessionHostIds()
          .map((hostId) => ({ hostId, session: sessions.getWorkspaceSession(hostId) }))
        if (ptyBindingIsRefused(args, session, bindingWorktreeId, paneKey, partitions)) {
          outcome = 'refused'
          return { value: false, persist: false }
        }
        reportPtyBindingPlacement(span, args, session, bindingWorktreeId)
        const verdict = evaluatePtyBindingFastLane(
          args,
          session,
          bindingWorktreeId,
          !runtime.quitFlushStarted && runtime.lastDurableWriteGeneration >= runtime.writeGeneration
        )
        span.setEligibility(verdict)
        if (verdict.eligible) {
          outcome = 'fast_lane'
          span.setPath('durable_match')
          return { value: true, persist: false }
        }
        if (isDurabilityOnlyMatch(verdict)) {
          span.setPath('durability_only')
          markPtyBindingSessionDirty(runtime, resolvedHostId)
          return durabilityOnlyBindingResult(resolvedHostId)
        }
        span.setPath('mutation')
        reportPtyBindingOwnerConflict(span, args, resolvedHostId, partitions)
        return {
          value: true,
          writtenHostIds: [resolvedHostId],
          rollback: writePtyBinding(this, args, resolvedHostId, bindingWorktreeId, paneKey)
        }
      })
      span?.finish(outcome)
      return persisted
    } catch (error) {
      span?.finish('threw', error)
      throw error
    }
  }

  /** Commit detached-tab moves before the renderer mounts the destination. */
  moveTerminalLeafToNewTab(request: TerminalLeafMoveRequest): Promise<TerminalLeafMoveResult> {
    return this[ptyBindingPersistenceOperationsContext].runtime.runDurableMutation(
      moveLeaf(request, this.topology())
    )
  }

  admitTerminalPane(
    admission: TerminalPaneAdmission,
    hostId?: string | null
  ): Promise<TerminalPaneAdmissionOutcome> {
    return this[ptyBindingPersistenceOperationsContext].runtime.runDurableMutation(
      admitPane(resolveHostId(hostId), admission, this.topology())
    )
  }

  /** stillStarting preserves panes that bound or began starting while withdrawal waited. */
  withdrawTerminalPane(
    pane: CommandOf<'closePane'>,
    hostId?: string | null,
    stillStarting?: () => boolean
  ): Promise<LayoutRefusalCode | UnstartedPaneKept | null> {
    const resolved = resolveHostId(hostId)
    return this[ptyBindingPersistenceOperationsContext].runtime.runDurableMutation(
      stillStarting
        ? withdrawUnstartedPane(resolved, pane, this.topology(), stillStarting)
        : withdrawPane(resolved, pane, this.topology())
    )
  }

  private topology(): TerminalTopologyCommitContext {
    return topologyCommitContext(this[ptyBindingPersistenceOperationsContext])
  }
}

export function writePtyBinding(
  owner: PtyBindingPersistenceOperations,
  args: PersistPtyBindingArgs,
  resolvedHostId: ReturnType<typeof resolveHostId>,
  bindingWorktreeId: string,
  paneKey: string
): () => void {
  const { runtime } = owner[ptyBindingPersistenceOperationsContext]
  const staged = runSessionOperation(runtime.state, resolvedHostId, {
    type: 'bindPty',
    binding: args,
    owner: bindingWorktreeId,
    paneKey
  })
  bumpPtyBindingGeneration(runtime, resolvedHostId, args.leafId)
  markPtyBindingSessionDirty(runtime, resolvedHostId)
  return () => {
    const inverse = runSessionOperation(runtime.state, resolvedHostId, {
      type: 'rollbackPty',
      staged,
      binding: { owner: bindingWorktreeId, tabId: args.tabId, leafId: args.leafId }
    })
    if (inverse.touchedFields().length) {
      bumpPtyBindingGeneration(runtime, resolvedHostId, args.leafId)
    }
  }
}
