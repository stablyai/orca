import { OrcaRuntimeWithOnPtyData } from '../output/pty-output-ingestion'
import {
  WAIT_BLOCKED_CHECK_MIN_INTERVAL_MS,
  WAIT_BLOCKED_KEYWORD_CARRY_CHARS,
  WAIT_BLOCKED_KEYWORD_PATTERN
} from '../../orca-runtime-postlude'
import {
  appendWaitBlockedCarry,
  createWaitBlockedCheckState,
  readWaitBlockedCarry,
  resetWaitBlockedCarry,
  type WaitBlockedCheckState
} from '../../wait-blocked-check-state'
import {
  computeTerminalTailWaitState,
  tailGainedNewerBlockedReason
} from '../../terminal-wait-tail-state'
import { ownRetainedString } from '../../../../shared/own-retained-string'
import type { ProcessedAgentStatusChunk } from '../../../../shared/agent-status-osc'
import { createTerminalAgentStatusProcessor } from '../../../../shared/terminal-agent-status-processor'
import type { RuntimePtyTitleTrackerEntry } from '../../runtime-terminal-state-records'

import type { OrcaRuntimeWithRecordAgentPromptLifecycleState } from '../output/terminal-output-generation'
import type { OrcaRuntimeWithEmitDaemonPtyTransientFact } from '../output/terminal-transient-facts'
import type { OrcaRuntimeWithGetUnpersistedTrackedTitleForPty } from '../output/terminal-title-tracker'

export abstract class OrcaRuntimeWithScheduleWaitBlockedCheck extends OrcaRuntimeWithOnPtyData {
  protected abstract recordAgentPromptPermissionObservation(
    ...args: Parameters<
      OrcaRuntimeWithRecordAgentPromptLifecycleState['recordAgentPromptPermissionObservation']
    >
  ): ReturnType<
    OrcaRuntimeWithRecordAgentPromptLifecycleState['recordAgentPromptPermissionObservation']
  >

  protected abstract emitTerminalSideEffectBatch(
    ...args: Parameters<OrcaRuntimeWithEmitDaemonPtyTransientFact['emitTerminalSideEffectBatch']>
  ): ReturnType<OrcaRuntimeWithEmitDaemonPtyTransientFact['emitTerminalSideEffectBatch']>

  protected abstract getOrCreatePtyTitleTrackerEntry(
    ...args: Parameters<
      OrcaRuntimeWithGetUnpersistedTrackedTitleForPty['getOrCreatePtyTitleTrackerEntry']
    >
  ): ReturnType<OrcaRuntimeWithGetUnpersistedTrackedTitleForPty['getOrCreatePtyTitleTrackerEntry']>

  protected scheduleWaitBlockedCheck(ptyId: string, appendedText: string, at: number): void {
    let state = this.waitBlockedCheckStateByPtyId.get(ptyId)
    if (!state) {
      state = createWaitBlockedCheckState()
      this.waitBlockedCheckStateByPtyId.set(ptyId, state)
    }
    // Fold carry and chunk once; per-chunk lowercasing would add another full copy.
    const keywordWindow = `${state.keywordCarry}${appendedText}`.toLowerCase()
    const keywordHit = WAIT_BLOCKED_KEYWORD_PATTERN.test(keywordWindow)
    // Own the tiny retained carry so it cannot pin the full lowercased output window.
    state.keywordCarry = ownRetainedString(keywordWindow.slice(-WAIT_BLOCKED_KEYWORD_CARRY_CHARS))
    appendWaitBlockedCarry(state.appended, appendedText)
    const elapsed = at - state.lastAt
    if (keywordHit || elapsed >= WAIT_BLOCKED_CHECK_MIN_INTERVAL_MS || elapsed < 0) {
      this.runWaitBlockedCheck(ptyId, state, at)
      return
    }
    if (!state.timer) {
      // Why trailing edge: the final chunks of a burst must still be
      // evaluated or a prompt arriving right after a flood would go
      // unstamped until the next output.
      state.timer = setTimeout(() => {
        state.timer = null
        this.runWaitBlockedCheck(ptyId, state, Date.now())
      }, WAIT_BLOCKED_CHECK_MIN_INTERVAL_MS - elapsed)
    }
  }

  /** Runs a pending trailing-edge scan now, so a reader never judges blocked text its stamp lags. */
  protected flushPendingWaitBlockedCheck(ptyId: string): void {
    const state = this.waitBlockedCheckStateByPtyId.get(ptyId)
    if (!state?.timer) {
      return
    }
    clearTimeout(state.timer)
    state.timer = null
    this.runWaitBlockedCheck(ptyId, state, Date.now())
  }

  protected runWaitBlockedCheck(ptyId: string, state: WaitBlockedCheckState, at: number): void {
    const pty = this.ptysById.get(ptyId)
    if (!pty) {
      resetWaitBlockedCarry(state.appended)
      return
    }
    const nextWaitState = computeTerminalTailWaitState(
      pty.tailBuffer,
      pty.tailPartialLine,
      pty.preview
    )
    const previousWaitState = state.lastWaitState ?? {
      waitText: '',
      signal: null,
      fromTail: false
    }
    if (
      tailGainedNewerBlockedReason(
        previousWaitState,
        nextWaitState,
        readWaitBlockedCarry(state.appended)
      )
    ) {
      pty.waitBlockedAt = at
      // Trailing scans run after onPtyData copies stamps to leaves; refresh those stamps before pane-backed waits read them.
      for (const leaf of this.getLeavesForPty(ptyId)) {
        if (leaf.tailBuffer === pty.tailBuffer) {
          leaf.waitBlockedAt = at
        }
      }
      this.recordAgentPromptPermissionObservation(ptyId)
    }
    state.lastAt = at
    state.lastWaitState = nextWaitState
    resetWaitBlockedCarry(state.appended)
  }

  /** Drops a stamp whose dialog the screen proved erased; a newly painted blocker stamps again. */
  protected clearWaitBlockedStamp(ptyId: string): void {
    const pty = this.ptysById.get(ptyId)
    if (pty) {
      pty.waitBlockedAt = null
    }
    // The screen is the whole PTY's evidence, so leaves with a diverged tail clear too.
    for (const leaf of this.getLeavesForPty(ptyId)) {
      leaf.waitBlockedAt = null
    }
  }

  // Prime seeded history without timestamps; only newly gained prompts in live output may stamp waitBlockedAt.
  protected primeWaitBlockedBaselineFromSeededTail(ptyId: string): void {
    const pty = this.ptysById.get(ptyId)
    if (!pty) {
      return
    }
    let state = this.waitBlockedCheckStateByPtyId.get(ptyId)
    if (!state) {
      state = createWaitBlockedCheckState()
      this.waitBlockedCheckStateByPtyId.set(ptyId, state)
    }
    if (state.lastWaitState === null) {
      state.lastWaitState = computeTerminalTailWaitState(
        pty.tailBuffer,
        pty.tailPartialLine,
        pty.preview
      )
    }
  }

  protected clearWaitBlockedCheckState(ptyId: string): void {
    const state = this.waitBlockedCheckStateByPtyId.get(ptyId)
    if (state?.timer) {
      clearTimeout(state.timer)
    }
    this.waitBlockedCheckStateByPtyId.delete(ptyId)
  }

  protected processAgentStatusOscForPty(ptyId: string, data: string): ProcessedAgentStatusChunk {
    let processor = this.agentStatusOscProcessorsByPtyId.get(ptyId)
    if (!processor) {
      processor = createTerminalAgentStatusProcessor()
      this.agentStatusOscProcessorsByPtyId.set(ptyId, processor)
    }
    return processor(data)
  }

  /** Emit the facts batched while applying one chunk/frame as a single
   *  pty:sideEffect batch, preserving byte order. */
  protected flushPendingTerminalSideEffectFacts(
    ptyId: string,
    entry: RuntimePtyTitleTrackerEntry
  ): void {
    if (entry.pendingFacts.length > 0) {
      const facts = entry.pendingFacts
      entry.pendingFacts = []
      this.emitTerminalSideEffectBatch(ptyId, facts)
    }
    const afterFacts = entry.afterFacts
    entry.afterFacts = []
    for (const run of afterFacts) {
      run()
    }
  }

  /** Runs `run` after the chunk being applied has emitted its facts, or now between chunks. */
  protected runAfterPendingTerminalSideEffectFacts(ptyId: string, run: () => void): void {
    const entry = this.ptyTitleTrackersByPtyId.get(ptyId)
    if (entry?.applyingChunk) {
      entry.afterFacts.push(run)
      return
    }
    run()
  }

  /** Synthetic title/bell frames update the stateless title path only, never emulator/tail/stats or the real escape scanner, which may hold a split OSC. Legacy byte delivery still applies when side effects are off. */
  ingestSyntheticTitleFrame(ptyId: string, data: string): void {
    const entry = this.getOrCreatePtyTitleTrackerEntry(ptyId)
    entry.applyingChunk = true
    entry.chunkTouchedSessionTabs = false
    try {
      entry.tracker.applySyntheticTitleFrame(data)
    } finally {
      entry.applyingChunk = false
      this.flushPendingTerminalSideEffectFacts(ptyId, entry)
    }
    if (entry.chunkTouchedSessionTabs) {
      this.touchMobileSessionSnapshotsForPty(ptyId)
    }
  }

  /** When daemon scan authority thins output, suppress main transient scans of gapped bytes to avoid duplicate/phantom facts; titles remain main-owned. */
  setPtyTransientFactDelegation(
    ptyId: string,
    delegated: boolean,
    scanSeedAnsi?: string,
    mode2031PendingSubscribe?: true
  ): void {
    const entry = this.getOrCreatePtyTitleTrackerEntry(ptyId)
    entry.tracker.setTransientFactScanningSuppressed(delegated)
    if (!delegated && scanSeedAnsi) {
      // Seed scanner carry at authority handoff so a split escape cannot mint/swallow bells; suppress title scanning because titles were never delegated.
      entry.tracker.handleChunk(scanSeedAnsi, {
        titleScanData: '',
        mode2031PendingSubscribe
      })
    }
  }
}
