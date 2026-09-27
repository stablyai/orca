// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithSerializeMainTerminalBuffer } from './orca-runtime-serialize-main-terminal-buffer'
import { MOBILE_SUBSCRIBE_SCROLLBACK_ROWS } from './scrollback-limits'
import { detectAgentStatusFromTitle, normalizeTerminalTitle } from '../../shared/agent-detection'
import type { RuntimeHeadlessTerminal } from './runtime-terminal-state-records'
import { TrailingTerminalOutputCapture } from './terminal-output-trailing-capture'
import { getOutputAfterSnapshotSeq } from './rpc/methods/terminal/terminal-stream-replay'
import { shouldModelAnswerHiddenPtyQueries } from './terminal-model-query-authority'

export class OrcaRuntimeWithMaybeHydrateHeadlessFromRenderer extends OrcaRuntimeWithSerializeMainTerminalBuffer {
  // Why: hydrate the runtime headless emulator from the desktop renderer's
  // xterm buffer on the first onPtyData byte after a PTY is taken over by a
  // pane. Eager-state pattern matches seedHeadlessTerminal: headlessTerminals
  // is populated synchronously so concurrent live writes from
  // trackHeadlessTerminalData chain after the seed via the same writeChain.
  // See docs/mobile-prefer-renderer-scrollback.md.
  protected maybeHydrateHeadlessFromRenderer(
    ptyId: string,
    beforeChunkSequence = this.getPtyOutputSequence(ptyId)
  ): void {
    const hydration = this.headlessHydrationState.get(ptyId)
    if (hydration === 'pending' || hydration === 'done') {
      return
    }
    const providerSnapshotPreferred = this.providerSnapshotPreferredPtys.has(ptyId)
    // Why the awaiting check: a viewer's frame-only emulator is not a seed —
    // counting it as one would skip the renderer's history forever.
    if (
      this.headlessTerminals.has(ptyId) &&
      !providerSnapshotPreferred &&
      hydration !== 'awaiting-serializer'
    ) {
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

    const state = this.getOrCreateHeadlessTerminal(ptyId)
    const generation = this.getPtyLifecycleGeneration(ptyId)
    const isCurrent = () =>
      this.headlessTerminals.get(ptyId) === state &&
      this.getPtyLifecycleGeneration(ptyId) === generation
    const trailing = new TrailingTerminalOutputCapture(beforeChunkSequence)
    const unsubscribe = this.subscribeToTerminalData(ptyId, (data, meta) =>
      trailing.push(data, meta)
    )
    this.headlessHydrationState.set(ptyId, 'pending')
    // Keep one chain owner so live writes queued during capture use the committed emulator.
    state.writeChain = state.writeChain.then(async () => {
      let candidate: RuntimeHeadlessTerminal | undefined
      let committed = false
      try {
        if (!isCurrent()) {
          return
        }
        const rendered = await controller.serializeBuffer!(ptyId, {
          scrollbackRows: MOBILE_SUBSCRIBE_SCROLLBACK_ROWS
        })
        if (!isCurrent() || !rendered || rendered.data.length === 0) {
          return
        }
        if (
          typeof rendered.seq === 'number' &&
          (rendered.seq < state.outputSequence ||
            rendered.seq > this.getPtyOutputSequence(ptyId) ||
            trailing.after(rendered.seq) === null)
        ) {
          return
        }
        candidate = this.createPtyHeadlessTerminalState(ptyId, rendered)
        await candidate.emulator.write(rendered.data)
        if (!isCurrent()) {
          return
        }
        const ptyDims = this.getTerminalSize(ptyId)
        if (ptyDims && (ptyDims.cols !== rendered.cols || ptyDims.rows !== rendered.rows)) {
          candidate.emulator.resize(ptyDims.cols, ptyDims.rows)
        }
        candidate.ownership.seedOwner(undefined, {
          alternateScreen: candidate.emulator.isAlternateScreen
        })
        const seedTitle = this.getTrackedRawTitleForPty(ptyId) ?? rendered.lastTitle
        if (seedTitle) {
          candidate.emulator.setLastTitle(seedTitle)
        }
        state.emulator.disableQueryReplyForwarding()
        state.emulator.dispose()
        state.ownership.dispose()
        state.emulator = candidate.emulator
        state.ownership = candidate.ownership
        state.rendererHydrationSequence = rendered.seq
        state.outputSequence = rendered.seq ?? state.outputSequence
        committed = true
        this.recordOsc7MetadataForPty(ptyId, rendered.data)
        this.recordRecentPtyOutputForPathProvenance(ptyId, rendered.data)
        if (seedTitle) {
          this.applySeededAgentStatus(ptyId, seedTitle)
        }
        this.providerSnapshotPreferredPtys.delete(ptyId)
      } catch {
        // Keep the incumbent model and retry on the next live chunk.
      } finally {
        unsubscribe()
        if (candidate && !committed) {
          candidate.ownership.dispose()
          candidate.emulator.dispose()
        }
        if (isCurrent()) {
          this.headlessHydrationState.set(ptyId, committed ? 'done' : 'awaiting-serializer')
        }
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
    forwardQueryReplies = false,
    rawLength = data.length,
    transformed = false
  ): Promise<void> {
    const state = this.getOrCreateHeadlessTerminal(ptyId)
    const completion = state.writeChain.then(async () => {
      // Why: the ingestion-time ownership decision is closed over this
      // chain link; async scheduling cannot retroactively change it.
      // Why inside the chain: the ownership mirror must observe live bytes in
      // the same total order as seeds (seedOwner also runs on this chain).
      const uncovered = getOutputAfterSnapshotSeq(
        { data, bytes: 0, meta: { seq: outputSequence, rawLength, transformed } },
        state.rendererHydrationSequence
      )
      if (!uncovered) {
        return
      }
      state.ownership.scan(uncovered.data)
      await state.emulator.write(uncovered.data, { forwardQueryReplies })
      state.outputSequence = outputSequence
    })
    // Legacy callers remain best-effort; bounded SSH admission observes the raw receipt.
    state.writeChain = completion.catch(() => {})
    return completion
  }
}
