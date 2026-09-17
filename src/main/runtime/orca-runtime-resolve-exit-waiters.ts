/* eslint-disable unicorn/no-useless-spread */
// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithBindPtyIncarnationHandle } from './orca-runtime-bind-pty-incarnation-handle'
import type { RuntimeLeafRecord, RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'
import { buildPtyTerminalWaitResult, buildTerminalWaitResult } from './terminal-wait-results'
import type { AgentStatus } from '../../shared/agent-detection'
import {
  detectExplicitIdleStatusFromTitle,
  detectKnownReadyPromptAgent
} from './terminal-wait-detection'
import { buildTerminalWaitText } from './terminal-wait-tail-state'
import {
  observeTuiIdle,
  type TuiIdleEvidenceCursor,
  type TuiIdleObservation
} from './tui-idle-evidence'

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
    // A title transition is only usable when the shared evidence evaluator identifies a
    // provider-supported readiness fact; name-only or otherwise unbound observations stay open.
    for (const waiter of [...waiters]) {
      if (waiter.condition === 'tui-idle') {
        if (
          waiter.processIncarnation === null ||
          this.getTerminalProcessIncarnation(handle) !== waiter.processIncarnation
        ) {
          this.removeWaiter(waiter)
          waiter.reject(new Error('terminal_handle_stale'))
          continue
        }
        const observation = this.observeTuiIdleForLeaf(leaf, waiter.evidenceCursor)
        if (observation.state !== 'ready') {
          continue
        }
        this.resolveWaiter(
          waiter,
          buildTerminalWaitResult(handle, 'tui-idle', leaf, {
            state: observation.state,
            source: observation.source,
            ...(observation.agent ? { agent: observation.agent } : {})
          })
        )
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
    for (const waiter of [...waiters]) {
      if (waiter.condition === 'tui-idle') {
        if (
          waiter.processIncarnation === null ||
          this.getTerminalProcessIncarnation(handle) !== waiter.processIncarnation
        ) {
          this.removeWaiter(waiter)
          waiter.reject(new Error('terminal_handle_stale'))
          continue
        }
        const observation = this.observeTuiIdleForPty(pty, waiter.evidenceCursor)
        if (observation.state !== 'ready') {
          continue
        }
        this.resolveWaiter(
          waiter,
          buildPtyTerminalWaitResult(handle, 'tui-idle', pty, {
            state: observation.state,
            source: observation.source,
            ...(observation.agent ? { agent: observation.agent } : {})
          })
        )
      }
    }
  }

  // Why: daemon-hosted terminals may have no PTY bytes; a title or screen fact can still prove readiness.
  protected isTuiIdleSatisfiedForLeaf(leaf: RuntimeLeafRecord): boolean {
    return this.observeTuiIdleForLeaf(leaf).state === 'ready'
  }

  protected observeTuiIdleForLeaf(
    leaf: RuntimeLeafRecord,
    evidenceCursor?: TuiIdleEvidenceCursor
  ): TuiIdleObservation {
    const waitText = buildTerminalWaitText(leaf.tailBuffer, leaf.tailPartialLine, leaf.preview)
    const promptAgent = detectKnownReadyPromptAgent(waitText)
    return observeTuiIdle({
      record: {
        ...leaf,
        attachmentId: leaf.ptyId ? this.getPtyAttachmentId(leaf.ptyId) : null,
        screenCapture: leaf.ptyId
          ? (this.visibleScreenCaptureByPtyId.get(leaf.ptyId) ?? null)
          : null
      },
      rendererTitle: leaf.paneTitle ?? this.tabs.get(leaf.tabId)?.title ?? null,
      readPositiveBodyEvidence: () => promptAgent !== null,
      positiveBodyEvidenceAgent: promptAgent,
      agent: this.getPaneAgentForTuiIdle(leaf.ptyId),
      firstPartyStatus:
        (leaf.ptyId ? this.ptysById.get(leaf.ptyId)?.lastExplicitAgentStatus : null) ?? null,
      evidenceCursor
    })
  }

  protected checkDeliverySettledAndArmRecheck(leaf: { tabId: string; leafId: string }): boolean {
    // Readiness is evidence-driven. A failed check stays parked until a new title, screen, or
    // hook fact arrives; elapsed silence is never allowed to unlock a write into a TUI.
    return this.isAgentSettledForDelivery(leaf)
  }

  /**
   * Whether this pane is settled enough to TYPE INTO.
   *
   * Why the same ranking as the wait path: mailbox delivery writes the pointer plus Enter
   * into the pane, so acting on a name-only `Codex` title mid-turn injects keystrokes into
   * a running agent's session. That is the #6011 mis-settlement in a path with a worse
   * failure mode than a racing script. Liveness stays a separate requirement — callers
   * keep their own `lastAgentStatusObservedLive` checks.
   */
  protected isAgentSettledForDelivery(leaf: { tabId: string; leafId: string }): boolean {
    const live = this.leaves.get(this.getLeafKey(leaf.tabId, leaf.leafId))
    return live ? this.isTuiIdleSatisfiedForLeaf(live) : false
  }

  protected isTuiIdleSatisfiedForPty(pty: RuntimePtyWorktreeRecord): boolean {
    return this.observeTuiIdleForPty(pty).state === 'ready'
  }

  protected observeTuiIdleForPty(
    pty: RuntimePtyWorktreeRecord,
    evidenceCursor?: TuiIdleEvidenceCursor
  ): TuiIdleObservation {
    const waitText = buildTerminalWaitText(pty.tailBuffer, pty.tailPartialLine, pty.preview)
    const promptAgent = detectKnownReadyPromptAgent(waitText)
    const adoptedIdle = this.getAdoptedPtyExplicitIdleStatus(pty) === 'idle'
    const adoptedTitle = this.getAdoptedPtyTitle(pty)
    return observeTuiIdle({
      record: {
        ...pty,
        lastOscTitleObservedAt: pty.lastOscTitleEpochMs,
        attachmentId: this.getPtyAttachmentId(pty.ptyId),
        screenCapture: this.visibleScreenCaptureByPtyId.get(pty.ptyId) ?? null
      },
      rendererTitle: adoptedTitle,
      readPositiveBodyEvidence: () => adoptedIdle || promptAgent !== null,
      positiveBodyEvidenceAgent: promptAgent,
      positiveBodyEvidenceSource: adoptedIdle ? 'title' : 'screen',
      agent: this.getPaneAgentForTuiIdle(pty.ptyId),
      firstPartyStatus: pty.lastExplicitAgentStatus ?? null,
      evidenceCursor
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
