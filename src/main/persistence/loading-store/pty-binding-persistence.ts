import { moveCanonicalTerminalLeaf } from '../terminal-topology/canonical-terminal-leaf-move'
import { retirePtyBindingSession } from './pty-binding-session-retirement'
import { persistCanonicalPtyBinding } from '../terminal-topology/canonical-pty-binding'
import { writePtyBinding } from './pty-binding-session-write'
import type { WorkspaceSurfaceCommands } from './workspace-surface-commands'
import {
  admitCanonicalTerminalPane,
  admitCanonicalTerminalRun,
  type TerminalRunAdmission,
  withdrawCanonicalTerminalPane
} from '../terminal-topology/canonical-pane-admission'
import { LOCAL_EXECUTION_HOST_ID, parseExecutionHostId } from '../../../shared/execution-host'

import type { PtyBindingSourceExpectation } from './store'
import type { SurfaceRunTarget } from '../../../shared/workspace-surfaces/surface-allocation'

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
  type PtyBindingOrigin,
  type PtyBindingSpan
} from './pty-binding-span'
import type { TerminalPanePlacement } from '../../../shared/terminal-pane-placement'
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

type PtyBindingPersistenceOperationsRuntime = Pick<
  StoreRuntimeState,
  | 'workspaceSurfaces'
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

export type PersistPtyBindingArgs = {
  worktreeId: string
  tabId: string
  leafId: string
  ptyId: string
  incarnationId?: string
  startupCwd?: string
  correctStartupCwd?: string
  expectedBinding?: { ptyId: string; incarnationId?: string }
  expectedSourceBinding?: PtyBindingSourceExpectation
  /** Spawns may precede layout saves; reattach must disable creation once absence proves a user close. */
  mayCreate?: boolean
  mayReviveRetiredSurface?: boolean
  /** Tracing metadata only; persistence must not branch on origin. */
  origin?: PtyBindingOrigin
  /** Report-only until main owns layout; then determines split placement. */
  placement?: TerminalPanePlacement
  /** Replacement without incarnationId clears the saved incarnation. */
  dropsIncarnation?: true
  /** The run accepted before asynchronous launch preparation, never recaptured on a late reply. */
  surfaceRunTarget?: SurfaceRunTarget
}

const ptyBindingPersistenceOperationsContext = Symbol('PtyBindingPersistenceOperations')
type PtyBindingPersistenceOperationsContext = {
  runtime: PtyBindingPersistenceOperationsRuntime
  sessions: SessionHostPartitionOperations
  surfaces?: WorkspaceSurfaceCommands
}

export class PtyBindingPersistenceOperations {
  readonly [ptyBindingPersistenceOperationsContext]: PtyBindingPersistenceOperationsContext

  constructor(
    runtime: PtyBindingPersistenceOperationsRuntime,
    sessions: SessionHostPartitionOperations,
    surfaces?: WorkspaceSurfaceCommands
  ) {
    this[ptyBindingPersistenceOperationsContext] = { runtime, sessions, surfaces }
  }

  /** Preserve the pane while clearing its dead binding; an incarnation fence narrows absence evidence. */
  async retirePtyBinding(
    binding: Pick<PersistPtyBindingArgs, 'worktreeId' | 'tabId' | 'leafId' | 'ptyId'>,
    hostId?: string | null,
    fence?: { incarnationId: string | undefined }
  ): Promise<boolean> {
    return retirePtyBindingSession(
      this[ptyBindingPersistenceOperationsContext],
      binding,
      hostId,
      fence
    )
  }

  async persistPtyBinding(
    input: PersistPtyBindingArgs | (() => PersistPtyBindingArgs | null),
    hostId?: string | null
  ): Promise<boolean> {
    const { runtime, sessions, surfaces } = this[ptyBindingPersistenceOperationsContext]
    const resolvedHostId = resolveHostId(hostId)
    if (surfaces && runtime.workspaceSurfaces?.initialized(resolvedHostId)) {
      return persistCanonicalPtyBinding(surfaces, runtime.workspaceSurfaces, input, resolvedHostId)
    }
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
          rollback: writePtyBinding(
            { runtime, sessions },
            args,
            session,
            resolvedHostId,
            bindingWorktreeId,
            paneKey
          )
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
    const { runtime, sessions, surfaces } = this[ptyBindingPersistenceOperationsContext]
    if (surfaces && runtime.workspaceSurfaces?.initialized('local')) {
      return moveCanonicalTerminalLeaf(runtime, sessions, surfaces, request)
    }
    return this[ptyBindingPersistenceOperationsContext].runtime.runDurableMutation(
      moveLeaf(request, this.topology())
    )
  }

  admitTerminalPane(
    admission: TerminalPaneAdmission,
    hostId?: string | null
  ): Promise<TerminalPaneAdmissionOutcome> {
    const { runtime, sessions, surfaces } = this[ptyBindingPersistenceOperationsContext]
    const resolved = resolveHostId(hostId)
    if (surfaces && runtime.workspaceSurfaces?.initialized(resolved)) {
      return admitCanonicalTerminalPane(
        { surfaces, sessions, reader: runtime.workspaceSurfaces },
        resolved,
        admission
      )
    }
    return this[ptyBindingPersistenceOperationsContext].runtime.runDurableMutation(
      admitPane(resolveHostId(hostId), admission, this.topology())
    )
  }

  async admitTerminalRun(
    admission: TerminalPaneAdmission,
    hostId?: string | null,
    expectedSource?: SurfaceRunTarget | null
  ): Promise<TerminalRunAdmission> {
    const { runtime, sessions, surfaces } = this[ptyBindingPersistenceOperationsContext]
    const resolved = resolveHostId(hostId)
    return surfaces && runtime.workspaceSurfaces?.initialized(resolved)
      ? admitCanonicalTerminalRun(
          { surfaces, sessions, reader: runtime.workspaceSurfaces },
          resolved,
          admission,
          expectedSource
        )
      : { outcome: await this.admitTerminalPane(admission, hostId), target: undefined }
  }

  /** stillStarting preserves panes that bound or began starting while withdrawal waited. */
  withdrawTerminalPane(
    pane: CommandOf<'closePane'>,
    hostId?: string | null,
    stillStarting?: () => boolean,
    expected?: SurfaceRunTarget
  ): Promise<LayoutRefusalCode | UnstartedPaneKept | null> {
    const resolved = resolveHostId(hostId)
    const { runtime, sessions, surfaces } = this[ptyBindingPersistenceOperationsContext]
    if (surfaces && runtime.workspaceSurfaces?.initialized(resolved)) {
      return withdrawCanonicalTerminalPane(
        { surfaces, sessions, reader: runtime.workspaceSurfaces },
        resolved,
        pane,
        stillStarting,
        expected
      )
    }
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
