// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithSerializeMainTerminalBuffer } from './orca-runtime-serialize-main-terminal-buffer'
import { MOBILE_SUBSCRIBE_SCROLLBACK_ROWS } from './scrollback-limits'
import { detectAgentStatusFromTitle, normalizeTerminalTitle } from '../../shared/agent-detection'
import { shouldModelAnswerHiddenPtyQueries } from './terminal-model-query-authority'

export class OrcaRuntimeWithMaybeHydrateHeadlessFromRenderer extends OrcaRuntimeWithSerializeMainTerminalBuffer {
  // Why: hydrate the runtime headless emulator from the desktop renderer's
  // xterm buffer on the first onPtyData byte after a PTY is taken over by a
  // pane. Eager-state pattern matches seedHeadlessTerminal: headlessTerminals
  // is populated synchronously so concurrent live writes from
  // trackHeadlessTerminalData chain after the seed via the same writeChain.
  // See docs/mobile-prefer-renderer-scrollback.md.
  protected maybeHydrateHeadlessFromRenderer(ptyId: string): void {
    if (this.headlessHydrationState.has(ptyId)) {
      return
    }
    const providerSnapshotPreferred = this.providerSnapshotPreferredPtys.has(ptyId)
    if (this.headlessTerminals.has(ptyId) && !providerSnapshotPreferred) {
      // Daemon-snapshot seed already populated the emulator — skip hydration.
      this.headlessHydrationState.set(ptyId, 'done')
      return
    }
    const controller = this.ptyController
    if (!controller?.serializeBuffer || !controller.hasRendererSerializer) {
      return
    }
    if (!controller.hasRendererSerializer(ptyId)) {
      // Renderer hasn't registered yet (or never will). Live writes lazy-
      // create the state via trackHeadlessTerminalData on this same tick.
      return
    }

    if (providerSnapshotPreferred) {
      // Why: a stream byte can create a partial model before restored history
      // arrives. A mounted renderer snapshot can safely replace that model.
      this.disposeHeadlessTerminal(ptyId)
    }

    this.headlessHydrationState.set(ptyId, 'pending')
    const dims = this.getTerminalSize(ptyId) ?? { cols: 80, rows: 24 }
    // Why: hydration writes below never set forwardQueryReplies (main-side
    // replay guard) — renderer-buffer snapshots can embed stale queries.
    const state = this.createPtyHeadlessTerminalState(ptyId, dims)
    state.outputSequence = this.getPtyOutputSequence(ptyId)
    this.headlessTerminals.set(ptyId, state)

    // Why: append the seed work to writeChain so live writes queued by
    // trackHeadlessTerminalData (after this method returns synchronously)
    // execute AFTER the seed-write resolves. If we awaited inline before
    // setting headlessTerminals, the live byte would lazy-create a separate
    // state and the seed-resolve would overwrite it, dropping live bytes.
    state.writeChain = state.writeChain.then(async () => {
      try {
        // Why the scrollback is not suppressed mid-TUI: the seed IS the model's
        // normal buffer, so zeroing it while an alt-screen agent was up left the
        // model with no pre-TUI history to restore from (#6106).
        const rendered = await controller.serializeBuffer!(ptyId, {
          scrollbackRows: MOBILE_SUBSCRIBE_SCROLLBACK_ROWS
        })
        if (!rendered || rendered.data.length === 0) {
          return
        }
        this.recordOsc7MetadataForPty(ptyId, rendered.data)
        this.recordRecentPtyOutputForPathProvenance(ptyId, rendered.data)
        // Resize to renderer's dims so the seed reflows correctly into the
        // emulator's grid, then resize back to PTY dims (if known) so live
        // writes use the correct cell layout.
        if (rendered.cols !== dims.cols || rendered.rows !== dims.rows) {
          state.emulator.resize(rendered.cols, rendered.rows)
        }
        await state.emulator.write(rendered.data)
        const ptyDims = this.getTerminalSize(ptyId)
        if (ptyDims && (ptyDims.cols !== rendered.cols || ptyDims.rows !== rendered.rows)) {
          state.emulator.resize(ptyDims.cols, ptyDims.rows)
        }
        // Why: the renderer xterm no longer sees synthetic hook title frames
        // (they feed main's tracker only), so its serializer lastTitle can be
        // stale here. Prefer main's tracked title; the renderer's is only the
        // seed when main has observed none (fresh relaunch, cold tracker).
        state.ownership.seedOwner(undefined, {
          alternateScreen: state.emulator.isAlternateScreen
        })
        const seedTitle = this.getTrackedRawTitleForPty(ptyId) ?? rendered.lastTitle
        if (seedTitle) {
          state.emulator.setLastTitle(seedTitle)
          this.applySeededAgentStatus(ptyId, seedTitle)
        }
        this.providerSnapshotPreferredPtys.delete(ptyId)
      } catch {
        // Hydration is best-effort. Live writes continue via the same
        // writeChain that this catch-arm leaves intact.
      } finally {
        this.headlessHydrationState.set(ptyId, 'done')
      }
    })
  }

  // Why: seed-derived agent status reflects historical state. Orchestration
  // waiters (resolveTuiIdleWaiters, deliverPendingMessages) must only react
  // to LIVE transitions, so this helper writes leaf.lastAgentStatus only,
  // leaves lastAgentStatusObservedLive untouched, and never resolves waiters.
  // detectAgentStatusFromTitle wrap mirrors the live path so seeded and live
  // values are the same union member, keeping downstream `=== 'idle'` checks
  // correct.
  protected applySeededAgentStatus(ptyId: string, title: string): void {
    if (!title) {
      return
    }
    // Why: a relaunched main starts its per-PTY title tracker cold — without
    // this seed it misses the parked working→idle completion and never arms
    // the stale-title timer for a persisted 'working' title. Seeding no-ops
    // once a live title was observed, so live state always wins.
    this.getOrCreatePtyTitleTrackerEntry(ptyId).tracker.seedInitialTitle(title)
    const status = detectAgentStatusFromTitle(title)
    // Why: live observations store normalized titles, so seeds must match —
    // otherwise the first live frame after hydration compares unequal and
    // touches session tabs once for no visible change.
    const seededTitle = normalizeTerminalTitle(title)
    const pty = this.ptysById.get(ptyId)
    if (pty) {
      const observedAt = this.nextTitleObservationSequence()
      pty.lastOscTitle = seededTitle
      pty.lastOscTitleAt = observedAt
      this.setPtyManagementTitleFromObservedTitle(pty, seededTitle, observedAt)
    }
    for (const leaf of this.getLeavesForPty(ptyId)) {
      // Why: seed lastOscTitle even when the seeded title doesn't classify
      // as an agent state, so worktree.ps recomputes status from the live
      // title rather than treating the leaf as agentless.
      leaf.lastOscTitle = seededTitle
      leaf.lastOscTitleAt = this.nextTitleObservationSequence()
      if (status !== null) {
        leaf.lastAgentStatus = status
      }
    }
  }

  /** Per-chunk reply-ownership capture (Phase 5). Evaluated synchronously at
   *  ingestion only — never re-read at reply time. */
  protected shouldAnswerQueriesForLiveChunk(ptyId: string): boolean {
    return shouldModelAnswerHiddenPtyQueries({
      ptyId,
      settings: this.store?.getSettings(),
      hasRemoteViewSubscriber: this.hasRemoteTerminalViewSubscriber(ptyId)
    })
  }

  protected trackHeadlessTerminalData(
    ptyId: string,
    data: string,
    outputSequence: number,
    forwardQueryReplies = false
  ): Promise<void> {
    const state = this.getOrCreateHeadlessTerminal(ptyId)
    const completion = state.writeChain.then(async () => {
      // Why: the ingestion-time ownership decision is closed over this
      // chain link; async scheduling cannot retroactively change it.
      // Why inside the chain: the ownership mirror must observe live bytes in
      // the same total order as seeds (seedOwner also runs on this chain).
      state.ownership.scan(data)
      await state.emulator.write(data, { forwardQueryReplies })
      state.outputSequence = outputSequence
    })
    // Legacy callers remain best-effort; bounded SSH admission observes the raw receipt.
    state.writeChain = completion.catch(() => {})
    return completion
  }
}
