import { TerminalSnapshotState } from '../../../../shared/terminal-snapshot-state'

import type { PtyTransientFact } from '../../../providers/pty-provider-contract'
import type {
  TerminalSideEffectBatch,
  TerminalSideEffectFact
} from '../../../../shared/terminal-side-effect-facts'
import {
  detectAgentStatusFromTitle,
  isCursorNativeAgentTitle,
  normalizeTerminalTitle
} from '../../../../shared/agent-detection'
import {
  getLeafDisplayRecord,
  getPtyDisplayRecord,
  type TitleDisplayClear
} from '../../runtime-worktree-status-projection'
import type {
  RuntimeLeafRecord,
  RuntimePtyWorktreeRecord
} from '../../runtime-terminal-state-records'
import type { TerminalTitleFactMeta } from '../../../../shared/terminal-output-side-effects'

import { OrcaRuntimeWithTerminalSnapshotApplication } from './terminal-snapshot-application'

export abstract class OrcaRuntimeWithEmitDaemonPtyTransientFact extends OrcaRuntimeWithTerminalSnapshotApplication {
  /** A transient fact the daemon detected while it held scan authority —
   *  emitted through the same fact channel as byte-scanned facts. Arrives
   *  between chunks, so recordTerminalSideEffectFact emits it immediately. */
  emitDaemonPtyTransientFact(ptyId: string, fact: PtyTransientFact): void {
    switch (fact.kind) {
      case 'command-started':
        this.recordTerminalSideEffectFact(ptyId, { kind: 'command-started' })
        return
      case 'bell':
        this.recordTerminalSideEffectFact(ptyId, { kind: 'bell' })
        return
      case 'command-finished':
        this.retirePtyAgentLaunchAuthorityOnConfirmedExit(ptyId)
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

  /** Output gaps reset every cross-chunk parser carry and the headless mirror; rebuild from delivered suffix or snapshot instead of parsing discontinuous escapes. */
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
      pty.commandPaint = undefined
    }
    for (const leaf of this.getLeavesForPty(ptyId)) {
      leaf.tailPendingAnsi = ''
    }
    this.ptyTitleTrackersByPtyId.get(ptyId)?.tracker.forgetCommandFinishedContext()
    this.oscTitleScanTailByPtyId.delete(ptyId)
    this.osc7ScanTailByPtyId.delete(ptyId)
    this.agentStatusOscProcessorsByPtyId.delete(ptyId)
    this.disposeHeadlessTerminal(ptyId)
  }

  /** Record one derived side-effect fact: batched per chunk while applying
   *  bytes, emitted immediately for between-chunk facts (stale-title timer). */
  protected recordTerminalSideEffectFact(
    ptyId: string,
    fact: TerminalSideEffectFact,
    qualification?: { observedAt: number; commandOrdinal: number }
  ): void {
    const entry = this.ptyTitleTrackersByPtyId.get(ptyId)
    if (entry) {
      entry.sideEffectState ??= new TerminalSnapshotState()
      entry.sideEffectState.state.rawEndSeq = this.ptyOutputSequenceById.get(ptyId) ?? 0
      entry.sideEffectState.record(
        fact.kind === 'pr-link' ? { kind: 'pr-link', url: fact.link.url } : fact,
        qualification?.observedAt,
        qualification?.commandOrdinal
      )
    }
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
    const state = this.ptyTitleTrackersByPtyId.get(ptyId)?.sideEffectState
    const incarnationId = this.ptyTitleTrackersByPtyId.get(ptyId)?.physicalIncarnationId
    if (!this.terminalSideEffectConsumerAvailable || (facts.length === 0 && !state)) {
      return
    }
    const batch: TerminalSideEffectBatch = {
      ptyId,
      seq: this.ptyOutputSequenceById.get(ptyId) ?? 0,
      facts,
      ...(state && incarnationId
        ? {
            terminalState: {
              runtimeId: this.runtimeId,
              incarnationId,
              snapshot: state.snapshot()
            }
          }
        : {}),
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

  getTerminalSideEffectClientEventSnapshot(): TerminalSideEffectBatch[] {
    return [...this.ptysById.keys()].flatMap((id) => {
      const batch = this.getTerminalSideEffectSnapshot(id)
      return batch ? [batch] : []
    })
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
    const recorded = this.paneOfPty(pty)
    if (pty && recorded.paneKey) {
      return {
        worktreeId: pty.worktreeId,
        ...(recorded.tabId ? { tabId: recorded.tabId } : {}),
        paneKey: recorded.paneKey,
        connectionId
      }
    }
    return {}
  }

  /** Title-only replay batch for renderer (re)attach — the no-attention-replay
   *  rule: snapshots restore title state, never historical bells/completions. */
  getTerminalSideEffectSnapshot(ptyId: string): TerminalSideEffectBatch | null {
    const entry = this.ptysById.has(ptyId)
      ? this.getOrCreatePtyTitleTrackerEntry(ptyId)
      : this.ptyTitleTrackersByPtyId.get(ptyId)
    if (entry && !entry.sideEffectState) {
      entry.sideEffectState = new TerminalSnapshotState()
      const rawTitle = entry.lastTitle?.raw ?? this.ptysById.get(ptyId)?.lastOscTitle
      if (rawTitle) {
        entry.sideEffectState.record(
          { kind: 'title', rawTitle, normalizedTitle: normalizeTerminalTitle(rawTitle) },
          this.ptysById.get(ptyId)?.lastOscTitleEpochMs ?? 0
        )
      }
    }
    if (entry?.sideEffectState && entry.physicalIncarnationId) {
      return {
        ptyId,
        seq: this.ptyOutputSequenceById.get(ptyId) ?? 0,
        facts: [],
        replay: true,
        terminalState: {
          runtimeId: this.runtimeId,
          incarnationId: entry.physicalIncarnationId,
          snapshot: entry.sideEffectState.snapshot()
        },
        ...this.resolveTerminalSideEffectAttribution(ptyId)
      }
    }
    const tracker = entry?.tracker
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

  /** The same title for main's synthetic title producer, which must see its own frames. */
  getTrackedPtyTitle(ptyId: string): string | null {
    return this.getTrackedRawTitleForPty(ptyId)
  }

  protected isLiveCursorNativeTitle(rawTitle: string, meta?: TerminalTitleFactMeta): boolean {
    return isCursorNativeAgentTitle(rawTitle) && meta?.staleWorkingTitleClear !== true
  }

  /** Display fallback for identities intentionally omitted from liveness records. */
  protected getTrackedDisplayTitleForPty(ptyId: string): string | null {
    return (
      this.getPtyTitleDisplayClear(ptyId)?.title ??
      this.getTrackedRawTitleForPty(ptyId) ??
      this.ptyTitleTrackersByPtyId.get(ptyId)?.tracker.getLastNormalizedTitle() ??
      null
    )
  }

  /** The stale-working timer's display-only clear of this PTY's native title, while it stands. */
  protected getPtyTitleDisplayClear(ptyId: string | null | undefined): TitleDisplayClear | null {
    const clear = ptyId ? this.ptysById.get(ptyId)?.titleDisplayClear : null
    return clear ? { ...clear, status: detectAgentStatusFromTitle(clear.title) } : null
  }

  protected getPtyDisplayRecord(pty: RuntimePtyWorktreeRecord): RuntimePtyWorktreeRecord {
    return getPtyDisplayRecord(pty, this.getPtyTitleDisplayClear(pty.ptyId))
  }

  protected getLeafDisplayRecord(leaf: RuntimeLeafRecord): RuntimeLeafRecord {
    return getLeafDisplayRecord(leaf, this.getPtyTitleDisplayClear(leaf.ptyId))
  }
}
