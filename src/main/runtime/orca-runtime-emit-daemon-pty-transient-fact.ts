// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithScheduleWaitBlockedCheck } from './orca-runtime-schedule-wait-blocked-check'
import type { PtyTransientFact } from '../providers/types'
import type {
  TerminalSideEffectBatch,
  TerminalSideEffectFact
} from '../../shared/terminal-side-effect-facts'
import { isCursorNativeAgentTitle, normalizeTerminalTitle } from '../../shared/agent-detection'
import type { TerminalTitleFactMeta } from '../../shared/terminal-output-side-effects'

export class OrcaRuntimeWithEmitDaemonPtyTransientFact extends OrcaRuntimeWithScheduleWaitBlockedCheck {
  /** A transient fact the daemon detected while it held scan authority —
   *  emitted through the same fact channel as byte-scanned facts. Arrives
   *  between chunks, so recordTerminalSideEffectFact emits it immediately. */
  emitDaemonPtyTransientFact(ptyId: string, fact: PtyTransientFact): void {
    switch (fact.kind) {
      case 'bell':
        this.recordTerminalSideEffectFact(ptyId, { kind: 'bell' })
        return
      case 'command-finished':
        this.retirePtyAgentLaunchAuthority(ptyId)
        this.recordTerminalSideEffectFact(ptyId, {
          kind: 'command-finished',
          exitCode: fact.exitCode
        })
        return
      case 'pr-link':
        this.recordTerminalSideEffectFact(ptyId, { kind: 'pr-link', link: fact.link })
        return
      case '2031-subscribe':
        this.recordTerminalSideEffectFact(ptyId, { kind: '2031-subscribe' })
        return
      case '2031-unsubscribe':
        this.recordTerminalSideEffectFact(ptyId, { kind: '2031-unsubscribe' })
    }
  }

  /** The daemon keep-tail dropped this PTY's oldest undelivered output; the
   *  next delivered chunk is discontinuous. Reset every cross-chunk parse
   *  carry so a half-open escape from before the gap cannot corrupt what
   *  follows, and drop the mobile headless mirror — it rebuilds from the
   *  delivered tail / snapshot seeds instead of parsing a gapped stream. */
  notePtyDataGap(ptyId: string, droppedChars = 0): void {
    if (droppedChars > 0) {
      // Why: the daemon snapshot's seq counts bytes its monitoring stream
      // dropped. Advancing without parsing preserves that absolute domain so
      // post-snapshot live chunks can be reconciled instead of duplicated.
      const outputSequence = (this.ptyOutputSequenceById.get(ptyId) ?? 0) + droppedChars
      this.ptyOutputSequenceById.set(ptyId, outputSequence)
    }
    const pty = this.getOrCreatePtyWorktreeRecord(ptyId)
    if (pty) {
      pty.tailPendingAnsi = ''
    }
    for (const leaf of this.getLeavesForPty(ptyId)) {
      leaf.tailPendingAnsi = ''
    }
    this.oscTitleScanTailByPtyId.delete(ptyId)
    this.osc7ScanTailByPtyId.delete(ptyId)
    this.agentStatusOscProcessorsByPtyId.delete(ptyId)
    this.disposeHeadlessTerminal(ptyId)
  }

  /** Record one derived side-effect fact: batched per chunk while applying
   *  bytes, emitted immediately for between-chunk facts (stale-title timer). */
  protected recordTerminalSideEffectFact(ptyId: string, fact: TerminalSideEffectFact): void {
    if (!this.terminalSideEffectConsumerAvailable) {
      return
    }
    const entry = this.ptyTitleTrackersByPtyId.get(ptyId)
    if (entry?.applyingChunk) {
      entry.pendingFacts.push(fact)
      return
    }
    this.emitTerminalSideEffectBatch(ptyId, [fact])
  }

  protected emitTerminalSideEffectBatch(
    ptyId: string,
    facts: TerminalSideEffectFact[],
    options: { replay?: boolean } = {}
  ): void {
    if (!this.terminalSideEffectConsumerAvailable || facts.length === 0) {
      return
    }
    const batch: TerminalSideEffectBatch = {
      ptyId,
      seq: this.ptyOutputSequenceById.get(ptyId) ?? 0,
      facts,
      ...(options.replay ? { replay: true } : {}),
      ...this.resolveTerminalSideEffectAttribution(ptyId)
    }
    if (this.terminalSideEffectLocalConsumerAvailable) {
      try {
        this.onTerminalSideEffects?.(batch)
      } catch (err) {
        console.error('[runtime] terminal side-effect listener threw', { ptyId, err })
      }
    }
    if (this.countTerminalSideEffectConsumingClientEventListeners() > 0) {
      this.emitClientEvent({ type: 'terminalSideEffects', batch })
    }
  }

  /** Same attribution resolution as emitTerminalAgentStatusEvents: prefer the
   *  first mounted leaf, fall back to the spawn-time PTY record binding. */
  protected resolveTerminalSideEffectAttribution(ptyId: string): {
    worktreeId?: string
    tabId?: string
    paneKey?: string
    connectionId?: string | null
  } {
    const pty = this.ptysById.get(ptyId)
    const connectionId = pty?.connectionId ?? null
    for (const leaf of this.getLeavesForPty(ptyId)) {
      return {
        worktreeId: leaf.worktreeId,
        tabId: leaf.tabId,
        paneKey: this.makeRuntimePaneKey(leaf),
        connectionId
      }
    }
    if (pty?.paneKey) {
      return {
        worktreeId: pty.worktreeId,
        ...(pty.tabId ? { tabId: pty.tabId } : {}),
        paneKey: pty.paneKey,
        connectionId
      }
    }
    return {}
  }

  /** Title-only replay batch for renderer (re)attach — the no-attention-replay
   *  rule: snapshots restore title state, never historical bells/completions. */
  getTerminalSideEffectSnapshot(ptyId: string): TerminalSideEffectBatch | null {
    const tracker = this.ptyTitleTrackersByPtyId.get(ptyId)?.tracker
    const recordTitle = this.ptysById.get(ptyId)?.lastOscTitle
    const normalizedTitle = tracker?.getLastNormalizedTitle() ?? null
    // Why: a record-fallback snapshot must not replay the bare cursor-agent literal over a
    // tracker title Orca synthesized from hooks — but with no tracker title it is the pane's
    // only Cursor identity, so restored/mobile tabs keep it (#10258).
    const rawTitle =
      recordTitle && (normalizedTitle === null || !isCursorNativeAgentTitle(recordTitle))
        ? recordTitle
        : null
    if (normalizedTitle === null && !rawTitle) {
      return null
    }
    return {
      ptyId,
      seq: this.ptyOutputSequenceById.get(ptyId) ?? 0,
      replay: true,
      facts: [
        {
          kind: 'title',
          normalizedTitle: normalizedTitle ?? normalizeTerminalTitle(rawTitle!),
          rawTitle: rawTitle ?? normalizedTitle!
        }
      ],
      ...this.resolveTerminalSideEffectAttribution(ptyId)
    }
  }

  /** Raw last title from main's tracked PTY/leaf records — the title surface
   *  the tracker (live bytes + synthetic frames) keeps current. */
  protected getTrackedRawTitleForPty(ptyId: string): string | null {
    const recordTitle = this.ptysById.get(ptyId)?.lastOscTitle
    if (recordTitle) {
      return recordTitle
    }
    for (const leaf of this.getLeavesForPty(ptyId)) {
      if (leaf.lastOscTitle) {
        return leaf.lastOscTitle
      }
    }
    return null
  }

  protected isLiveCursorNativeTitle(rawTitle: string, meta?: TerminalTitleFactMeta): boolean {
    return isCursorNativeAgentTitle(rawTitle) && meta?.staleWorkingTitleClear !== true
  }

  /** Display fallback for identities intentionally omitted from liveness records. */
  protected getTrackedDisplayTitleForPty(ptyId: string): string | null {
    return (
      this.getTrackedRawTitleForPty(ptyId) ??
      this.ptyTitleTrackersByPtyId.get(ptyId)?.tracker.getLastNormalizedTitle() ??
      null
    )
  }
}
