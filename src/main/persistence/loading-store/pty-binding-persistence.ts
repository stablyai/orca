import { isDeepStrictEqual } from 'node:util'
import { LOCAL_EXECUTION_HOST_ID, parseExecutionHostId } from '../../../shared/execution-host'
import { isTerminalLeafId } from '../../../shared/stable-pane-id'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { rollbackFailedPtyBinding } from './pty-binding-write-rollback'
import { cloneWorkspaceSessionState } from '../restoring-sessions/session-owner-fields'

import type { PtyBindingSourceExpectation } from './store'

import type { StoreRuntimeState } from './store-runtime-state'
import type { SessionHostPartitionOperations } from './session-host-partitions'
import { resolveHostId } from './session-host-partitions'
import { evaluatePtyBindingFastLane } from './pty-binding-fast-lane'
import { ptyBindingIsRefused } from './pty-binding-refusals'
import { startPtyBindingSpan, type PtyBindingOrigin, type PtyBindingSpan } from './pty-binding-span'
import { applyPtyBinding } from './pty-binding-session-update'

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
>

export type PersistPtyBindingArgs = {
  worktreeId: string
  tabId: string
  leafId: string
  ptyId: string
  incarnationId?: string
  startupCwd?: string
  expectedBinding?: { ptyId: string; incarnationId?: string }
  expectedSourceBinding?: PtyBindingSourceExpectation
  /** Set by host-initiated creates, which have no renderer session writer behind them. */
  hostAdmittedMembership?: boolean
  /**
   * Defaults true, which is what `pty:spawn` needs — it can beat the debounced layout writer
   * and must be able to mint the surface it is binding. A reattach is the opposite: the pane
   * either still exists or the user closed it, so creating one grafts back a tab they closed.
   * Callers pass false only once absence is meaningful; see the relay's reattach bind.
   */
  mayCreate?: boolean
  /** Reattach must not revive a surface a prior build durably recorded as retired. */
  mayReviveRetiredSurface?: boolean
  /** Span metadata only; see `PtyBindingOrigin`. The write path never reads it. */
  origin?: PtyBindingOrigin
}

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
        // Measure the admitted binding operation; queue time precedes its current-state checks.
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
          .map((hostId) => sessions.getWorkspaceSession(hostId))
        if (ptyBindingIsRefused(args, session, bindingWorktreeId, paneKey, partitions)) {
          outcome = 'refused'
          return { value: false, persist: false }
        }
        const verdict = evaluatePtyBindingFastLane(
          args,
          session,
          bindingWorktreeId,
          !runtime.quitFlushStarted && runtime.lastDurableWriteGeneration >= runtime.writeGeneration
        )
        span.setEligibility(verdict)
        if (verdict.eligible) {
          outcome = 'fast_lane'
          return { value: true, persist: false }
        }
        return {
          value: true,
          rollback: writePtyBinding(this, args, session, resolvedHostId, bindingWorktreeId, paneKey)
        }
      })
      span?.finish(outcome)
      return persisted
    } catch (error) {
      span?.finish('threw', error)
      throw error
    }
  }
}

function writePtyBinding(
  owner: PtyBindingPersistenceOperations,
  args: PersistPtyBindingArgs,
  session: WorkspaceSessionState,
  resolvedHostId: ReturnType<typeof resolveHostId>,
  bindingWorktreeId: string,
  paneKey: string
): () => void {
  const { runtime, sessions } = owner[ptyBindingPersistenceOperationsContext]
  const sessionBeforeBinding = cloneWorkspaceSessionState(session)
  const restore = (restoredSession = sessionBeforeBinding): void => {
    if (resolvedHostId === LOCAL_EXECUTION_HOST_ID) {
      runtime.state.workspaceSession = restoredSession
    } else {
      runtime.state.workspaceSessionsByHostId = {
        ...runtime.state.workspaceSessionsByHostId,
        [resolvedHostId]: restoredSession
      }
    }
  }
  try {
    if (resolvedHostId !== LOCAL_EXECUTION_HOST_ID) {
      runtime.state.workspaceSessionsByHostId = {
        ...runtime.state.workspaceSessionsByHostId,
        [resolvedHostId]: session
      }
    }
    applyPtyBinding(args, session, bindingWorktreeId, paneKey)
    runtime.dirtyProfileStateDomains?.add(
      resolvedHostId === LOCAL_EXECUTION_HOST_ID ? 'workspaceSession' : 'workspaceSessionsByHostId'
    )
    const boundSession = cloneWorkspaceSessionState(session)
    return () => {
      const current = sessions.getWorkspaceSession(resolvedHostId)
      const ownerState = (value: WorkspaceSessionState) => {
        const tab = value.tabsByWorktree[bindingWorktreeId]?.find((tab) => tab.id === args.tabId)
        return {
          createdAt: tab?.createdAt,
          generation: tab?.generation,
          worktreeId: tab?.worktreeId,
          ptyId: isTerminalLeafId(args.leafId)
            ? value.terminalLayoutsByTabId[args.tabId]?.ptyIdsByLeafId?.[args.leafId]
            : tab?.ptyId,
          incarnation: value.terminalPtyIncarnationsByPaneKey?.[paneKey]
        }
      }
      // Presentation edits do not replace the binding that must be rolled back.
      if (!isDeepStrictEqual(ownerState(current), ownerState(boundSession))) {
        return
      }
      const rolledBack = rollbackFailedPtyBinding(
        sessionBeforeBinding,
        boundSession,
        current,
        bindingWorktreeId,
        args.tabId,
        args.leafId
      )
      if (rolledBack !== current) {
        restore(rolledBack)
      }
    }
  } catch (error) {
    restore()
    throw error
  }
}

export function installPtyBindingPersistenceOperationsContext(
  target: PtyBindingPersistenceOperations,
  source: PtyBindingPersistenceOperations
): void {
  Object.defineProperty(target, ptyBindingPersistenceOperationsContext, {
    value: source[ptyBindingPersistenceOperationsContext]
  })
}
