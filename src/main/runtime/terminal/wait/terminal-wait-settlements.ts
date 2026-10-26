import { OrcaRuntimeWithBindPtyIncarnationHandle } from '../identity/terminal-handle-bindings'
import type {
  RuntimeLeafRecord,
  RuntimePtyWorktreeRecord
} from '../../runtime-terminal-state-records'
import {
  buildPtyTerminalWaitBlockedResult,
  buildPtyTerminalWaitResult,
  buildTerminalWaitBlockedResult,
  buildTerminalWaitResult
} from '../../terminal-wait-results'
import type { AgentStatus } from '../../../../shared/agent-detection'
import { detectExplicitIdleStatusFromTitle } from '../../terminal-wait-detection'
import { buildTerminalWaitText } from '../../terminal-wait-tail-state'
import {
  evaluateTuiIdle,
  isTuiIdleReadyVerdict,
  type TuiIdleVerdict
} from '../../tui-idle-evidence'
import { leafTuiIdleEvidence, ptyTuiIdleEvidence } from '../../tui-idle-evidence-source'
import { TUI_IDLE_QUIESCENCE_MS } from '../../orca-runtime-postlude'
import { USER_INPUT_HOLD_CAP_MS } from '../../claude-open-dialog-hold'
import { detectTerminalComposerDraft } from '../../../../shared/terminal-composer-draft'

import type { OrcaRuntimeWithResolveWaiter } from '../../orca-runtime-resolve-waiter'

const DIALOG_HOLD_RECHECK_MS = 2000

export abstract class OrcaRuntimeWithResolveExitWaiters extends OrcaRuntimeWithBindPtyIncarnationHandle {
  protected abstract resolveWaiter(
    ...args: Parameters<OrcaRuntimeWithResolveWaiter['resolveWaiter']>
  ): ReturnType<OrcaRuntimeWithResolveWaiter['resolveWaiter']>

  protected abstract removeWaiter(
    ...args: Parameters<OrcaRuntimeWithResolveWaiter['removeWaiter']>
  ): ReturnType<OrcaRuntimeWithResolveWaiter['removeWaiter']>

  protected resolveExitWaiters(leaf: RuntimeLeafRecord): void {
    const handle = this.issueHandle(leaf)
    if (!handle) {
      return
    }
    const waiters = this.terminalWaiters.get(handle)
    if (!waiters || waiters.size === 0) {
      return
    }
    for (const waiter of Array.from(waiters)) {
      if (waiter.condition === 'exit') {
        this.resolveWaiter(waiter, buildTerminalWaitResult(handle, 'exit', leaf))
      } else {
        // Why: after exit, conditions like tui-idle can never be satisfied — reject now instead of spinning the poll until timeout on a dead process.
        this.removeWaiter(waiter)
        waiter.reject(new Error('terminal_exited'))
      }
    }
  }

  protected resolveTuiIdleWaiters(leaf: RuntimeLeafRecord): void {
    const leafKey = this.getLeafKey(leaf.tabId, leaf.leafId)
    const candidateHandle =
      this.handleByLeafKey.get(leafKey) ??
      (leaf.ptyId
        ? (this.handleByPtyId.get(leaf.ptyId) ??
          this.handleByPtyIncarnation.get(leaf.ptyId)?.handle)
        : undefined)
    if (!candidateHandle || !this.terminalWaiters.get(candidateHandle)?.size) {
      return
    }
    const handle = candidateHandle
    const waiters = this.terminalWaiters.get(handle)
    if (!waiters || waiters.size === 0) {
      return
    }
    // Re-rank titles: weak readiness cannot see tail-truncated dialogs and must wait for a rendered-screen poll.
    const verdict = this.evaluateTuiIdleForLeaf(leaf)
    for (const waiter of Array.from(waiters)) {
      if (waiter.condition !== 'tui-idle') {
        continue
      }
      if (verdict.kind === 'blocked') {
        this.resolveWaiter(
          waiter,
          buildTerminalWaitBlockedResult(handle, 'tui-idle', leaf, verdict.reason)
        )
      } else if (verdict.kind === 'ready-strong') {
        this.resolveWaiter(waiter, buildTerminalWaitResult(handle, 'tui-idle', leaf))
      }
    }
  }

  protected resolvePtyExitWaiters(pty: RuntimePtyWorktreeRecord, ptyId: string): void {
    const handle = this.handleByPtyId.get(ptyId)
    if (!handle) {
      return
    }
    const waiters = this.terminalWaiters.get(handle)
    if (!waiters || waiters.size === 0) {
      return
    }
    for (const waiter of Array.from(waiters)) {
      if (waiter.condition === 'exit') {
        this.resolveWaiter(waiter, buildPtyTerminalWaitResult(handle, 'exit', pty))
      } else {
        this.removeWaiter(waiter)
        waiter.reject(new Error('terminal_exited'))
      }
    }
  }

  protected resolvePtyTuiIdleWaiters(pty: RuntimePtyWorktreeRecord, ptyId: string): void {
    const handle = this.handleByPtyId.get(ptyId)
    if (!handle) {
      return
    }
    const waiters = this.terminalWaiters.get(handle)
    if (!waiters || waiters.size === 0) {
      return
    }
    // Why: same re-ranking as resolveTuiIdleWaiters above.
    const verdict = this.evaluateTuiIdleForPty(pty)
    for (const waiter of Array.from(waiters)) {
      if (waiter.condition !== 'tui-idle') {
        continue
      }
      if (verdict.kind === 'blocked') {
        this.resolveWaiter(
          waiter,
          buildPtyTerminalWaitBlockedResult(handle, 'tui-idle', pty, verdict.reason)
        )
      } else if (verdict.kind === 'ready-strong') {
        this.resolveWaiter(waiter, buildPtyTerminalWaitResult(handle, 'tui-idle', pty))
      }
    }
  }

  protected evaluateTuiIdleForLeaf(leaf: RuntimeLeafRecord): TuiIdleVerdict {
    return evaluateTuiIdle(
      leafTuiIdleEvidence(this.tuiIdleEvidenceSource, leaf, () =>
        buildTerminalWaitText(leaf.tailBuffer, leaf.tailPartialLine, leaf.preview)
      )
    )
  }

  /** Edge-driven delivery needs a one-shot recheck when quiet evidence may later settle; otherwise hookless agents can strand queued mail without another title/graph/message edge. */
  protected checkDeliverySettledAndArmRecheck(leaf: { tabId: string; leafId: string }): boolean {
    const leafKey = this.getLeafKey(leaf.tabId, leaf.leafId)
    if (this.isAgentSettledForDelivery(leaf)) {
      this.clearDeliveryRecheck(leafKey)
      return true
    }
    this.armDeliveryRecheck(leafKey)
    return false
  }

  protected clearDeliveryRecheck(leafKey: string): void {
    const timer = this.deliveryRecheckTimersByLeafKey.get(leafKey)
    if (timer) {
      clearTimeout(timer)
      this.deliveryRecheckTimersByLeafKey.delete(leafKey)
    }
  }

  private armDeliveryRecheck(leafKey: string): void {
    if (this.deliveryRecheckTimersByLeafKey.has(leafKey)) {
      return
    }
    const live = this.leaves.get(leafKey) ?? this.getPtyLaneMailboxTarget(leafKey)?.pty
    // Only quiet-window refusal expires with time; schedule just beyond it and re-arm from fresher output if still streaming.
    const elapsed = live?.lastOutputAt ? Date.now() - live.lastOutputAt : 0
    // A dialog or draft lifts only when the user acts, so poll it slowly rather than at 20 Hz.
    const delay =
      live?.ptyId && this.isPtyHoldingDelivery(live.ptyId)
        ? DIALOG_HOLD_RECHECK_MS
        : Math.max(TUI_IDLE_QUIESCENCE_MS - elapsed, 0) + 50
    const timer = setTimeout(() => {
      this.deliveryRecheckTimersByLeafKey.delete(leafKey)
      const current = this.leaves.get(leafKey) ?? this.getPtyLaneMailboxTarget(leafKey)?.leaf
      if (!current) {
        return
      }
      // Recheck settlement before retry delivery; the pane may have become busy again.
      if (this.checkDeliverySettledAndArmRecheck(current)) {
        this.deliverPendingMessagesForLeaf(current)
      }
    }, delay)
    timer.unref?.()
    this.deliveryRecheckTimersByLeafKey.set(leafKey, timer)
  }

  /** Pointer plus Enter requires the same readiness ranking as waits; name-only titles can occur mid-turn (#6011). Callers separately require live status evidence. */
  protected isAgentSettledForDelivery(leaf: { tabId: string; leafId: string }): boolean {
    const leafKey = this.getLeafKey(leaf.tabId, leaf.leafId)
    const live = this.leaves.get(leafKey)
    // A pane no window publishes (headless serve) carries its evidence on its PTY record.
    const lanePty = live ? null : this.getPtyLaneMailboxTarget(leafKey)?.pty
    const evidence = live
      ? leafTuiIdleEvidence(this.tuiIdleEvidenceSource, live, () =>
          buildTerminalWaitText(live.tailBuffer, live.tailPartialLine, live.preview)
        )
      : lanePty
        ? ptyTuiIdleEvidence(this.tuiIdleEvidenceSource, lanePty, () =>
            buildTerminalWaitText(lanePty.tailBuffer, lanePty.tailPartialLine, lanePty.preview)
          )
        : null
    const ptyId = live ? live.ptyId : lanePty?.ptyId
    if (!evidence || (ptyId && this.isPtyHoldingDelivery(ptyId))) {
      return false
    }
    // Why no blocked reader: a refusal here re-arms a recheck that a lingering tail prompt
    // would spin, so delivery keeps its own, blocked-blind, reading of the same ranking.
    return isTuiIdleReadyVerdict(
      evaluateTuiIdle({ ...evidence, readTailBlockedReason: () => null })
    )
  }

  /** An unsent draft would be submitted with the injected text; the cap bounds an abandoned or misread one. */
  private isPtyHoldingDelivery(ptyId: string): boolean {
    if (this.isPtyAwaitingUserInput(ptyId)) {
      return true
    }
    const lastInputAt = this.terminalRunFacts.readLastDrivingInputAt(ptyId)
    const state = this.readWholeScreenModel(ptyId)
    return (
      lastInputAt !== null &&
      Date.now() - lastInputAt <= USER_INPUT_HOLD_CAP_MS &&
      !!state &&
      detectTerminalComposerDraft(state.emulator.getCursorLineContext()) !== null
    )
  }

  protected evaluateTuiIdleForPty(pty: RuntimePtyWorktreeRecord): TuiIdleVerdict {
    return evaluateTuiIdle(
      ptyTuiIdleEvidence(this.tuiIdleEvidenceSource, pty, () =>
        buildTerminalWaitText(pty.tailBuffer, pty.tailPartialLine, pty.preview)
      )
    )
  }

  protected getAdoptedPtyExplicitIdleStatus(pty: RuntimePtyWorktreeRecord): AgentStatus | null {
    const title = pty.lastOscTitle ?? this.getAdoptedPtyTitle(pty)
    return title ? detectExplicitIdleStatusFromTitle(title) : null
  }

  protected getAdoptedPtyTitle(pty: RuntimePtyWorktreeRecord): string | null {
    for (const leaf of this.leaves.values()) {
      if (leaf.ptyId !== pty.ptyId) {
        continue
      }
      const title = leaf.paneTitle ?? this.tabs.get(leaf.tabId)?.title
      if (!title) {
        continue
      }
      return title
    }
    return null
  }
}
