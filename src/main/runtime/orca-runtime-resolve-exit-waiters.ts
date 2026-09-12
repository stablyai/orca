/* eslint-disable unicorn/no-useless-spread */
// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithBindPtyIncarnationHandle } from './orca-runtime-bind-pty-incarnation-handle'
import type { RuntimeLeafRecord, RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'
import { buildPtyTerminalWaitResult, buildTerminalWaitResult } from './terminal-wait-results'
import type { AgentStatus } from '../../shared/agent-detection'
import {
  detectExplicitIdleStatusFromTitle,
  isKnownReadyPromptPreview
} from './terminal-wait-detection'
import { buildTerminalWaitText } from './terminal-wait-tail-state'
import { isTuiIdleSatisfied } from './tui-idle-evidence'
import { TUI_IDLE_QUIESCENCE_MS } from './orca-runtime-postlude'

export class OrcaRuntimeWithResolveExitWaiters extends OrcaRuntimeWithBindPtyIncarnationHandle {
  protected resolveExitWaiters(leaf: RuntimeLeafRecord): void {
    const handle = this.issueHandle(leaf)
    if (!handle) {
      return
    }
    const waiters = this.terminalWaiters.get(handle)
    if (!waiters || waiters.size === 0) {
      return
    }
    for (const waiter of [...waiters]) {
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
    // Why re-rank rather than resolve outright: the transition that brought us here is
    // only a title sample, and a name-only title arriving mid-turn is the weakest tier
    // there is (#6011). Leave such a waiter on its poll to be corroborated instead.
    if (!this.isTuiIdleSatisfiedForLeaf(leaf)) {
      return
    }
    for (const waiter of [...waiters]) {
      if (waiter.condition === 'tui-idle') {
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
    for (const waiter of [...waiters]) {
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
    if (!this.isTuiIdleSatisfiedForPty(pty)) {
      return
    }
    for (const waiter of [...waiters]) {
      if (waiter.condition === 'tui-idle') {
        this.resolveWaiter(waiter, buildPtyTerminalWaitResult(handle, 'tui-idle', pty))
      }
    }
  }

  // Why: the primary OSC-title signal can't fire for daemon-hosted terminals (no PTY data through the runtime), so this fallback polls the renderer-synced tab title + foreground-process quiescence; self-cancels when the OSC path fires.
  protected isTuiIdleSatisfiedForLeaf(leaf: RuntimeLeafRecord): boolean {
    return isTuiIdleSatisfied({
      record: leaf,
      rendererTitle: leaf.paneTitle ?? this.tabs.get(leaf.tabId)?.title ?? null,
      positiveBodyEvidence: isKnownReadyPromptPreview(
        buildTerminalWaitText(leaf.tailBuffer, leaf.tailPartialLine, leaf.preview)
      ),
      agent: this.getPaneAgentForTuiIdle(leaf.ptyId),
      firstPartyStatus:
        (leaf.ptyId ? this.ptysById.get(leaf.ptyId)?.lastExplicitAgentStatus : null) ?? null,
      quiescenceMs: TUI_IDLE_QUIESCENCE_MS
    })
  }

  protected isTuiIdleSatisfiedForPty(pty: RuntimePtyWorktreeRecord): boolean {
    return isTuiIdleSatisfied({
      record: pty,
      positiveBodyEvidence:
        this.getAdoptedPtyExplicitIdleStatus(pty) === 'idle' ||
        isKnownReadyPromptPreview(
          buildTerminalWaitText(pty.tailBuffer, pty.tailPartialLine, pty.preview)
        ),
      agent: this.getPaneAgentForTuiIdle(pty.ptyId),
      firstPartyStatus: pty.lastExplicitAgentStatus ?? null,
      quiescenceMs: TUI_IDLE_QUIESCENCE_MS
    })
  }

  protected getAdoptedPtyExplicitIdleStatus(pty: RuntimePtyWorktreeRecord): AgentStatus | null {
    const title = this.getAdoptedPtyTitle(pty)
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

  protected settlePendingMessageDelivery(
    ptyId: string,
    flight: { enterTimer: ReturnType<typeof setTimeout> | null }
  ): void {
    if (this.messageDeliveryFlightsByPtyId.get(ptyId) !== flight) {
      return
    }
    this.messageDeliveryFlightsByPtyId.delete(ptyId)
    const parked = this.parkedMessageRedeliveriesByPtyId.get(ptyId)
    if (!parked) {
      return
    }
    this.parkedMessageRedeliveriesByPtyId.delete(ptyId)
    for (const [mailboxHandle, delivery] of parked) {
      this.deliverPendingMessages(delivery.leaf, {
        mailboxHandle,
        reservedTypes: delivery.reservedTypes
      })
    }
  }
}
