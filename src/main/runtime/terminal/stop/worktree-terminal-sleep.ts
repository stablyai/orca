import { OrcaRuntimeWithAgentGeneratedTabTitles } from '../layout/agent-generated-tab-titles-runtime'
import {
  includeTargetResolvedWorktree,
  type ResolvedWorktree
} from '../../workspaces/catalog/runtime-worktree-path-identity'
import type { RuntimeWorktreeTerminalSleepResult } from '../../../../shared/runtime-terminal-contracts'

import {
  sleptNothing,
  unverifiedSleepResult,
  stopSleepingTerminals,
  markSleepingTerminalStops,
  classifyTerminalSleepStops,
  terminalSleepStopFailure
} from './worktree-terminal-sleep-result'
import type { WorktreeSleepScope } from './worktree-terminal-sleep-key'
import { withoutCwdGuesses } from './worktree-pty-collection'
// Renderer waits 15s; release the spawn fence and return verified failure before its deadline.
const WORKTREE_TERMINAL_SLEEP_TIMEOUT_MS = 12_000

export abstract class OrcaRuntimeWithSleepResolvedWorktreeTerminals extends OrcaRuntimeWithAgentGeneratedTabTitles {
  protected async sleepResolvedWorktreeTerminals(
    worktree: ResolvedWorktree,
    scope: WorktreeSleepScope,
    soleLivePtyId?: string
  ): Promise<RuntimeWorktreeTerminalSleepResult> {
    const sleepDeadline = Date.now() + WORKTREE_TERMINAL_SLEEP_TIMEOUT_MS
    const release = await this.acquireWorktreeTerminalMutation(
      worktree.id,
      'exclusive',
      sleepDeadline
    )
    const { key, fence } = scope
    // Fenced: a same-id twin's PTYs are another host's; a cwd guess may be a same-path sibling's (#36716).
    const liveHere = (fresh: ReadonlySet<string>) =>
      withoutCwdGuesses(this.ptysById, this.getLivePtyIdsForWorktree(worktree.id, fresh, fence))
    const existingSleepState = this.terminalSleepStateByHostWorktree.get(key)
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
        if (liveHere(refreshedPtyLiveness).size === 0) {
          release()
          return sleptNothing()
        }
        this.emitClientEvent({
          type: 'worktreeTerminalSleepState',
          worktreeId: existingSleepState.worktreeId,
          generation: existingSleepState.generation,
          phase: 'woken',
          ptyIds: existingSleepState.ptyIds,
          terminalHandles: existingSleepState.terminalHandles
        })
        this.terminalSleepStateByHostWorktree.delete(key)
      } catch (error) {
        release()
        throw error
      }
    }
    const priorPartialState = existingSleepState?.phase === 'partial' ? existingSleepState : null
    const committedPtyIds = new Set(priorPartialState?.ptyIds ?? [])
    const terminalHandlesByPtyId = { ...priorPartialState?.terminalHandlesByPtyId }
    const pendingPtyIds = new Set<string>()
    let generation = 0
    let fullyCommitted = false
    let settleResumeCapture: ((running: readonly string[]) => Promise<void>) | undefined
    let provenRunningPtyIds: readonly string[] = []
    const settleReversibleStops = new Map<string, (stopped: boolean) => void>()
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
      const livePtyIds = liveHere(refreshedPtyLiveness)
      // Why under the lock: any other live terminal here is a user's, and no spawn can slip in now.
      if (soleLivePtyId && [...livePtyIds].some((ptyId) => ptyId !== soleLivePtyId)) {
        return sleptNothing(livePtyIds)
      }
      generation = ++this.terminalSleepGeneration
      for (const ptyId of livePtyIds) {
        pendingPtyIds.add(ptyId)
        terminalHandlesByPtyId[ptyId] = this.getTerminalHandlesForPtyId(ptyId)
      }
      const liveTerminalHandles = this.getRecordedTerminalSleepHandles(
        livePtyIds,
        terminalHandlesByPtyId
      )
      this.terminalSleepStateByHostWorktree.set(key, {
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
        this.terminalSleepStateByHostWorktree.set(key, {
          worktreeId: worktree.id,
          generation,
          phase: 'sleeping',
          ptyIds: [...committedPtyIds].sort(),
          terminalHandles,
          terminalHandlesByPtyId
        })
        fullyCommitted = true
        return sleptNothing()
      }
      // Why before the stop: a PTY's exit clears its hook rows, and with them the session ids.
      const resumeCapture = await this.sleepResumeRecords.capture(worktree.id, livePtyIds)
      const ptyController = this.ptyController
      if (!ptyController?.stopAndWait) {
        throw new Error('terminal_worktree_sleep_unavailable')
      }
      const stopAndWait = ptyController.stopAndWait.bind(ptyController)
      const captureTransaction = await this.sleepResumeRecords.prepare(
        worktree.id,
        resumeCapture,
        () => this.terminalSleepStateByHostWorktree.get(key)?.generation === generation
      )

      settleResumeCapture = captureTransaction.settle
      const orderedLivePtyIds = [...livePtyIds].sort()
      markSleepingTerminalStops(settleReversibleStops, orderedLivePtyIds, (ptyId) =>
        this.intentionalPtyStops.mark(
          ptyId,
          'reversible',
          this.ptysById.get(ptyId)?.incarnationId ?? null
        )
      )
      const stopResults = await stopSleepingTerminals(
        orderedLivePtyIds,
        stopAndWait,
        sleepDeadline,
        (ptyId, stopped) => {
          this.notifyMobileSessionTabsChanged(worktree.id)
          settleReversibleStops.get(ptyId)?.(stopped)
        }
      )
      const { successfulStopPtyIds, failedStopIndex } = classifyTerminalSleepStops(
        orderedLivePtyIds,
        stopResults
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
        // Why: the stops were acknowledged and their hook rows are gone; a retry has nothing to capture.
        if (!captureTransaction.staged) {
          await this.sleepResumeRecords.persist(worktree.id, resumeCapture, successfulStopPtyIds)
        }
        if (failedStopIndex !== -1) {
          throw terminalSleepStopFailure(
            worktree.id,
            orderedLivePtyIds[failedStopIndex],
            stopResults[failedStopIndex]
          )
        }
        return unverifiedSleepResult(successfulStopPtyIds, livePtyIds)
      }
      const remainingLivePtyIds = liveHere(postStopLiveness)
      provenRunningPtyIds = [...remainingLivePtyIds]
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
      if (!captureTransaction.staged) {
        await this.sleepResumeRecords.persist(worktree.id, resumeCapture, provenStoppedPtyIds)
      }
      if (failedStopIndex !== -1 && remainingLivePtyIds.size > 0) {
        throw terminalSleepStopFailure(
          worktree.id,
          orderedLivePtyIds[failedStopIndex],
          stopResults[failedStopIndex],
          [...remainingLivePtyIds]
        )
      }
      if (remainingLivePtyIds.size > 0) {
        return unverifiedSleepResult(successfulStopPtyIds, livePtyIds, remainingLivePtyIds)
      }
      const terminalHandles = this.getRecordedTerminalSleepHandles(
        committedPtyIds,
        terminalHandlesByPtyId
      )
      this.terminalSleepStateByHostWorktree.set(key, {
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
      await settleResumeCapture?.(provenRunningPtyIds)
      for (const settleStop of settleReversibleStops.values()) {
        settleStop(false)
      }
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
          this.terminalSleepStateByHostWorktree.set(key, {
            worktreeId: worktree.id,
            generation,
            phase: 'partial',
            ptyIds: [...committedPtyIds].sort(),
            terminalHandles,
            terminalHandlesByPtyId
          })
        } else {
          this.terminalSleepStateByHostWorktree.delete(key)
        }
      }
      release()
    }
  }
}
