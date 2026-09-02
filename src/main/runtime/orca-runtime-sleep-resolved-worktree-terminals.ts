// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithStopTerminalsForWorktree } from './orca-runtime-stop-terminals-for-worktree'
import type { ResolvedWorktree } from './runtime-worktree-path-identity'
import type { RuntimeWorktreeTerminalSleepResult } from '../../shared/runtime-types'
import { WORKTREE_TERMINAL_SLEEP_TIMEOUT_MS } from './orca-runtime-postlude'
import {
  includeTargetResolvedWorktree,
  runtimeWorktreeIdentityKey
} from './runtime-worktree-path-identity'
import { teardownRpcDeadline } from './worktree-teardown'

export class OrcaRuntimeWithSleepResolvedWorktreeTerminals extends OrcaRuntimeWithStopTerminalsForWorktree {
  protected async sleepResolvedWorktreeTerminals(
    worktree: ResolvedWorktree
  ): Promise<RuntimeWorktreeTerminalSleepResult> {
    const sleepDeadline = Date.now() + WORKTREE_TERMINAL_SLEEP_TIMEOUT_MS
    const releaseMutation = await this.acquireWorktreeTerminalMutation(
      worktree.id,
      'exclusive',
      sleepDeadline
    )
    const key = runtimeWorktreeIdentityKey(worktree.id)
    const existingSleepState = this.terminalSleepStateByWorktreeId.get(key)
    if (existingSleepState?.phase === 'sleeping') {
      try {
        const resolvedWorktrees = includeTargetResolvedWorktree(
          [...(await this.getResolvedWorktreeMap()).values()],
          worktree
        )
        const refreshedPtyLiveness = await this.refreshPtyWorktreeRecordsFromController(
          resolvedWorktrees,
          worktree.id,
          sleepDeadline
        )
        if (!refreshedPtyLiveness) {
          throw new Error('terminal_liveness_unavailable')
        }
        if (this.getLivePtyIdsForWorktree(worktree.id, refreshedPtyLiveness).size === 0) {
          releaseMutation()
          return {
            stopped: 0,
            stoppedPtyIds: [],
            livePtyIds: [],
            postStopVerified: true
          }
        }
        this.emitClientEvent({
          type: 'worktreeTerminalSleepState',
          worktreeId: existingSleepState.worktreeId,
          generation: existingSleepState.generation,
          phase: 'woken',
          ptyIds: existingSleepState.ptyIds,
          terminalHandles: existingSleepState.terminalHandles
        })
        this.terminalSleepStateByWorktreeId.delete(key)
      } catch (error) {
        releaseMutation()
        throw error
      }
    }
    const priorPartialState = existingSleepState?.phase === 'partial' ? existingSleepState : null
    const committedPtyIds = new Set(priorPartialState?.ptyIds ?? [])
    const terminalHandlesByPtyId = { ...priorPartialState?.terminalHandlesByPtyId }
    const pendingPtyIds = new Set<string>()
    let generation = 0
    let fullyCommitted = false
    let releaseReversibleRendererStops = (): void => {}
    try {
      const resolvedWorktrees = includeTargetResolvedWorktree(
        [...(await this.getResolvedWorktreeMap()).values()],
        worktree
      )
      const refreshedPtyLiveness = await this.refreshPtyWorktreeRecordsFromController(
        resolvedWorktrees,
        worktree.id,
        sleepDeadline
      )
      if (!refreshedPtyLiveness) {
        throw new Error('terminal_liveness_unavailable')
      }
      const livePtyIds = this.getLivePtyIdsForWorktree(worktree.id, refreshedPtyLiveness)
      generation = ++this.terminalSleepGeneration
      for (const ptyId of livePtyIds) {
        pendingPtyIds.add(ptyId)
        terminalHandlesByPtyId[ptyId] = this.getTerminalHandlesForPtyId(ptyId)
      }
      const liveTerminalHandles = this.getRecordedTerminalSleepHandles(
        livePtyIds,
        terminalHandlesByPtyId
      )
      this.terminalSleepStateByWorktreeId.set(key, {
        worktreeId: worktree.id,
        generation,
        phase: 'stopping',
        ptyIds: [...committedPtyIds].sort(),
        terminalHandles: this.getRecordedTerminalSleepHandles(
          committedPtyIds,
          terminalHandlesByPtyId
        ),
        terminalHandlesByPtyId
      })
      this.emitClientEvent({
        type: 'worktreeTerminalSleepState',
        worktreeId: worktree.id,
        generation,
        phase: 'started',
        ptyIds: [...livePtyIds].sort(),
        terminalHandles: liveTerminalHandles
      })
      if (committedPtyIds.size > 0) {
        this.emitClientEvent({
          type: 'worktreeTerminalSleepState',
          worktreeId: worktree.id,
          generation,
          phase: 'committed',
          ptyIds: [...committedPtyIds].sort(),
          terminalHandles: this.getRecordedTerminalSleepHandles(
            committedPtyIds,
            terminalHandlesByPtyId
          )
        })
      }
      if (livePtyIds.size === 0) {
        const terminalHandles = this.getRecordedTerminalSleepHandles(
          committedPtyIds,
          terminalHandlesByPtyId
        )
        this.terminalSleepStateByWorktreeId.set(key, {
          worktreeId: worktree.id,
          generation,
          phase: 'sleeping',
          ptyIds: [...committedPtyIds].sort(),
          terminalHandles,
          terminalHandlesByPtyId
        })
        fullyCommitted = true
        return {
          stopped: 0,
          stoppedPtyIds: [],
          livePtyIds: [],
          postStopVerified: true
        }
      }
      const ptyController = this.ptyController
      if (!ptyController?.stopAndWait) {
        throw new Error('terminal_worktree_sleep_unavailable')
      }
      const stopAndWait = ptyController.stopAndWait.bind(ptyController)

      const orderedLivePtyIds = [...livePtyIds].sort()
      releaseReversibleRendererStops =
        ptyController.markReversibleStops?.(orderedLivePtyIds) ?? (() => {})
      const stopResults = await Promise.allSettled(
        orderedLivePtyIds.map(async (ptyId) => ({
          ptyId,
          stopped: await stopAndWait(ptyId, {
            keepHistory: true,
            deadlineMs: teardownRpcDeadline(sleepDeadline)
          })
        }))
      )
      const successfulStopPtyIds = orderedLivePtyIds.filter((_, index) => {
        const result = stopResults[index]
        return result?.status === 'fulfilled' && result.value.stopped
      })
      const failedStopIndex = stopResults.findIndex((result) =>
        result.status === 'rejected' ? true : !result.value.stopped
      )

      const postStopLiveness = await this.refreshPtyWorktreeRecordsFromController(
        resolvedWorktrees,
        worktree.id,
        sleepDeadline
      )
      if (!postStopLiveness) {
        this.commitWorktreeTerminalSleepPtys({
          worktreeId: worktree.id,
          generation,
          ptyIds: successfulStopPtyIds,
          pendingPtyIds,
          committedPtyIds,
          terminalHandlesByPtyId
        })
        if (failedStopIndex !== -1) {
          const failedStop = stopResults[failedStopIndex]
          throw Object.assign(new Error('terminal_worktree_sleep_failed'), {
            ptyId: orderedLivePtyIds[failedStopIndex],
            ...(failedStop.status === 'rejected' ? { cause: failedStop.reason } : {})
          })
        }
        return {
          stopped: successfulStopPtyIds.length,
          stoppedPtyIds: successfulStopPtyIds,
          livePtyIds: [...livePtyIds].sort(),
          postStopVerified: false,
          postStopFailure: 'terminal_liveness_unavailable'
        }
      }
      const remainingLivePtyIds = this.getLivePtyIdsForWorktree(worktree.id, postStopLiveness)
      const provenStoppedPtyIds = orderedLivePtyIds.filter(
        (ptyId) => !remainingLivePtyIds.has(ptyId)
      )
      this.commitWorktreeTerminalSleepPtys({
        worktreeId: worktree.id,
        generation,
        ptyIds: provenStoppedPtyIds,
        pendingPtyIds,
        committedPtyIds,
        terminalHandlesByPtyId
      })
      if (failedStopIndex !== -1 && remainingLivePtyIds.size > 0) {
        const failedStop = stopResults[failedStopIndex]
        console.error('[runtime] worktree terminal sleep physical stop failed', {
          worktreeId: worktree.id,
          ptyId: orderedLivePtyIds[failedStopIndex],
          cause: failedStop.status === 'rejected' ? failedStop.reason : 'stop_not_acknowledged'
        })
        throw Object.assign(new Error('terminal_worktree_sleep_failed'), {
          ptyId: orderedLivePtyIds[failedStopIndex],
          remainingLivePtyIds: [...remainingLivePtyIds].sort(),
          ...(failedStop.status === 'rejected' ? { cause: failedStop.reason } : {})
        })
      }
      if (remainingLivePtyIds.size > 0) {
        return {
          stopped: successfulStopPtyIds.length,
          stoppedPtyIds: successfulStopPtyIds,
          livePtyIds: [...livePtyIds].sort(),
          postStopVerified: false,
          postStopFailure: 'terminal_worktree_sleep_still_live',
          remainingLivePtyIds: [...remainingLivePtyIds].sort()
        }
      }
      const terminalHandles = this.getRecordedTerminalSleepHandles(
        committedPtyIds,
        terminalHandlesByPtyId
      )
      this.terminalSleepStateByWorktreeId.set(key, {
        worktreeId: worktree.id,
        generation,
        phase: 'sleeping',
        ptyIds: [...committedPtyIds].sort(),
        terminalHandles,
        terminalHandlesByPtyId
      })
      fullyCommitted = true
      return {
        stopped: provenStoppedPtyIds.length,
        stoppedPtyIds: provenStoppedPtyIds,
        livePtyIds: [...livePtyIds].sort(),
        postStopVerified: true
      }
    } finally {
      releaseReversibleRendererStops()
      if (!fullyCommitted && generation > 0) {
        const cancelledPtyIds = [...pendingPtyIds].sort()
        if (cancelledPtyIds.length > 0) {
          this.emitClientEvent({
            type: 'worktreeTerminalSleepState',
            worktreeId: worktree.id,
            generation,
            phase: 'cancelled',
            ptyIds: cancelledPtyIds,
            terminalHandles: this.getRecordedTerminalSleepHandles(
              cancelledPtyIds,
              terminalHandlesByPtyId
            )
          })
        }
        if (committedPtyIds.size > 0) {
          const terminalHandles = this.getRecordedTerminalSleepHandles(
            committedPtyIds,
            terminalHandlesByPtyId
          )
          this.terminalSleepStateByWorktreeId.set(key, {
            worktreeId: worktree.id,
            generation,
            phase: 'partial',
            ptyIds: [...committedPtyIds].sort(),
            terminalHandles,
            terminalHandlesByPtyId
          })
        } else {
          this.terminalSleepStateByWorktreeId.delete(key)
        }
      }
      releaseMutation()
    }
  }
}
