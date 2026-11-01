import type {
  RuntimeHeadlessTerminal,
  RuntimePtyWorktreeRecord
} from '../../runtime-terminal-state-records'
import type { AgentStatusIpcPayload } from '../../../../shared/agent-status-types'
import { splitFreebuffScreenUpdates } from '../../../../shared/freebuff-screen-status'
import { OrcaRuntimeWithSerializeMainTerminalBuffer } from './terminal-buffer-operations'
import { observeFreebuffTerminalStatus } from '../../freebuff-terminal-status'
import {
  observeCodexCapacityTerminalStatus,
  observeCodexReconnectFailure
} from '../../codex-notice-terminal-status'
import { TrustDialogStatusObserver } from '../../trust-dialog-status-observer'
import type { LaunchedAgentForeground } from '../../launched-agent-foreground'
import type { TuiAgent } from '../../../../shared/tui-agent'
import {
  detectAgentStatusFromTitle,
  normalizeTerminalTitle
} from '../../../../shared/agent-detection'
import { shouldModelAnswerHiddenPtyQueries } from '../../terminal-model-query-authority'
import { advancePartialEscapeTail } from '../../../../shared/terminal-partial-escape-tail'

export abstract class OrcaRuntimeWithMaybeHydrateHeadlessFromRenderer extends OrcaRuntimeWithSerializeMainTerminalBuffer {
  protected abstract getOrCreateHeadlessTerminal(ptyId: string): RuntimeHeadlessTerminal
  protected abstract markPaneLiveTitlesDirty(): void
  protected abstract settleLostAgentSession(ptyId: string): void
  abstract readLaunchedAgentForeground(
    ptyId: string,
    agent: TuiAgent
  ): Promise<LaunchedAgentForeground>

  protected readonly trustDialogStatus = new TrustDialogStatusObserver({
    getPaneAgent: (ptyId) => this.getPaneAgentForTuiIdle(ptyId),
    refreshForegroundAgent: (ptyId) => this.ptyForegroundAgent.refresh(ptyId),
    readLaunchedAgentForeground: (ptyId, agent) => this.readLaunchedAgentForeground(ptyId, agent),
    getEmulator: (ptyId) =>
      this.ptysById.has(ptyId) ? this.headlessTerminals.get(ptyId)?.emulator : undefined,
    readStatus: (ptyId) => {
      const pty = this.ptysById.get(ptyId)
      return pty ? this.readPtyAgentStatusRow(ptyId, pty) : undefined
    },
    publish: (ptyId, payload) =>
      this.emitTerminalAgentStatusEvents(
        ptyId,
        { cleanData: '', payloads: [payload], lastPayloadCleanOffset: null },
        undefined,
        false
      )
  })

  // Create emulator state synchronously and chain renderer hydration first so concurrent live bytes cannot be overwritten by a late seed (docs/mobile-prefer-renderer-scrollback.md).
  maybeHydrateHeadlessFromRenderer(ptyId: string): Promise<boolean> | null {
    if (this.headlessHydrationState.has(ptyId)) {
      return null
    }
    const providerSnapshotPreferred = this.providerSnapshotPreferredPtys.has(ptyId)
    if (this.headlessTerminals.has(ptyId) && !providerSnapshotPreferred) {
      // Daemon-snapshot seed already populated the emulator — skip hydration.
      this.headlessHydrationState.set(ptyId, 'done')
      return null
    }
    const controller = this.ptyController
    if (!controller?.serializeBuffer || !controller.hasRendererSerializer) {
      return null
    }
    if (!controller.hasRendererSerializer(ptyId)) {
      // Renderer hasn't registered yet (or never will). Live writes lazy-
      // create the state via trackHeadlessTerminalData on this same tick.
      return null
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

    // Queue seed before live writes on the same state; awaiting before publishing state would lose concurrent bytes.
    let seeded = false
    state.writeChain = state.writeChain.then(async () => {
      if (this.headlessTerminals.get(ptyId) !== state) {
        return
      }
      try {
        // Retain normal-buffer scrollback while a TUI is in alt-screen so pre-TUI history remains restorable (#6106).
        // This emulator's retention: a hidden-output reveal repaints the pane from this model.
        const rendered = await controller.serializeBuffer!(ptyId, {
          scrollbackRows: this.headlessTerminalScrollbackRows
        })
        if (
          this.headlessTerminals.get(ptyId) !== state ||
          !rendered ||
          rendered.data.length === 0
        ) {
          return
        }
        this.recordOsc7MetadataForPty(ptyId, rendered.data)
        this.recordRecentPtyOutput(ptyId, rendered.data)
        // Resize to renderer's dims so the seed reflows correctly into the
        // emulator's grid, then resize back to PTY dims (if known) so live
        // writes use the correct cell layout.
        if (rendered.cols !== dims.cols || rendered.rows !== dims.rows) {
          state.emulator.resize(rendered.cols, rendered.rows)
        }
        await state.emulator.write(rendered.data)
        if (this.headlessTerminals.get(ptyId) !== state) {
          return
        }
        // Why: the renderer parsed live bytes queued behind this seed while serializing; writing them again doubles TUI frames and splits escapes.
        if (typeof rendered.seq === 'number') {
          state.rendererSeedSeq = rendered.seq
        }
        const ptyDims = this.getTerminalSize(ptyId)
        if (ptyDims && (ptyDims.cols !== rendered.cols || ptyDims.rows !== rendered.rows)) {
          state.emulator.resize(ptyDims.cols, ptyDims.rows)
        }
        // Synthetic hook titles bypass xterm; prefer main's tracked title, using renderer title only for a cold tracker.
        state.ownership.seedOwner(undefined, {
          alternateScreen: state.emulator.isAlternateScreen
        })
        const seedTitle = this.getTrackedRawTitleForPty(ptyId) ?? rendered.lastTitle
        if (seedTitle) {
          state.emulator.setLastTitle(seedTitle)
          this.applySeededAgentStatus(ptyId, seedTitle)
        }
        this.providerSnapshotPreferredPtys.delete(ptyId)
        seeded = true
      } catch {
        // Hydration is best-effort. Live writes continue via the same
        // writeChain that this catch-arm leaves intact.
      } finally {
        if (this.headlessTerminals.get(ptyId) === state) {
          this.headlessHydrationState.set(ptyId, 'done')
        }
      }
    })
    return state.writeChain.then(() => seeded)
  }

  // Historical seeds update display status only, never live evidence, waiters or orchestration delivery.
  protected applySeededAgentStatus(ptyId: string, title: string): void {
    if (!title) {
      return
    }
    // Seed cold title trackers for completion/stale-working timers; observed live titles always win.
    this.getOrCreatePtyTitleTrackerEntry(ptyId).tracker.seedInitialTitle(title)
    const status = detectAgentStatusFromTitle(title)
    // Store normalized title evidence like live output; display clears still project over native working titles.
    const seededTitle = normalizeTerminalTitle(title)
    const pty = this.ptysById.get(ptyId)
    if (pty) {
      const observedAt = this.nextTitleObservationSequence()
      pty.lastOscTitle = seededTitle
      pty.lastOscTitleAt = observedAt
      this.setPtyManagementTitleFromObservedTitle(pty, seededTitle, observedAt)
    }
    for (const leaf of this.getLeavesForPty(ptyId)) {
      // Seed even non-agent titles so worktree.ps can reclassify instead of treating the pane as agentless.
      leaf.lastOscTitle = seededTitle
      leaf.lastOscTitleAt = this.nextTitleObservationSequence()
      if (status !== null) {
        leaf.lastAgentStatus = status
      }
    }
    this.markPaneLiveTitlesDirty()
  }

  /** Capture reply ownership synchronously at ingestion; never re-read it when the queued write runs. */
  protected shouldAnswerQueriesForLiveChunk(ptyId: string): boolean {
    return shouldModelAnswerHiddenPtyQueries({
      ptyId,
      settings: this.store?.getSettings(),
      hasRemoteViewSubscriber: this.hasRemoteTerminalViewSubscriber(ptyId)
    })
  }

  /** True when this PTY's queries go unanswered unless its single receiving remote view answers them. */
  isSoleRemoteTerminalQueryOwner(ptyId: string): boolean {
    return (
      this.terminalViewSubscribers.remoteAnsweringQueriesCount(ptyId) === 1 &&
      shouldModelAnswerHiddenPtyQueries({
        ptyId,
        settings: this.store?.getSettings(),
        hasRemoteViewSubscriber: false
      })
    )
  }

  /** Answer stateless queries a sole remote view owned at ingestion but will never receive. */
  answerYieldedTerminalQueries(ptyId: string, statelessQueryData: string): void {
    const state = this.headlessTerminals.get(ptyId)
    if (!state) {
      return
    }
    state.writeChain = state.writeChain
      .then(async () => {
        // Why drop, not retry: injecting mid-escape corrupts live parsing, and a deferred reply risks arriving after the query timed out.
        if (state.emulator.partialEscapeTailAnsi === '') {
          await state.emulator.write(statelessQueryData, { forwardQueryReplies: true })
        }
      })
      .catch(() => {})
  }

  protected trackHeadlessTerminalData(
    ptyId: string,
    data: string,
    outputSequence: number,
    forwardQueryReplies = false
  ): void {
    const state = this.getOrCreateHeadlessTerminal(ptyId)
    const outputObservedAt = Date.now()
    const completion = state.writeChain.then(async () => {
      // Capture reply ownership at ingestion, then scan inside the chain so live bytes and seeds retain total order.
      state.ownership.scan(data)
      if (state.rendererSeedSeq !== undefined) {
        if (outputSequence <= state.rendererSeedSeq) {
          state.rendererSeedEscapeTail = advancePartialEscapeTail(
            state.rendererSeedEscapeTail ?? '',
            data
          )
          state.outputSequence = outputSequence
          return
        }
        const escapeTail = state.rendererSeedEscapeTail
        state.rendererSeedSeq = undefined
        state.rendererSeedEscapeTail = undefined
        if (escapeTail) {
          await state.emulator.write(escapeTail)
        }
      }
      for (const chunk of splitFreebuffScreenUpdates(data, state.emulator.partialEscapeTailAnsi)) {
        await state.emulator.write(chunk, { forwardQueryReplies })
        const pty = this.ptysById.get(ptyId)
        if (!pty || this.headlessTerminals.get(ptyId) !== state) {
          continue
        }
        const command = this.terminalSpawnCommandsByPtyId.get(ptyId)
        const readStatus = () => this.readPtyAgentStatusRow(ptyId, pty)
        // Remote hosts report status themselves, but only this runtime can settle its own dispatches.
        if (
          observeCodexReconnectFailure(state.emulator, chunk, command, pty.launchAgent, readStatus)
        ) {
          this.settleLostAgentSession(ptyId)
        }
        if (!pty.connectionId) {
          this.trustDialogStatus.observe(ptyId, state.emulator, chunk)
          const payload =
            observeCodexCapacityTerminalStatus(
              state.emulator,
              chunk,
              command,
              pty.launchAgent,
              readStatus,
              outputObservedAt
            ) ?? observeFreebuffTerminalStatus(state.emulator, chunk, command, pty.launchAgent)
          if (payload) {
            pty.lastExplicitAgentStatus = {
              state: payload.state,
              updatedAt: Date.now(),
              sessionBoundary: payload.sessionBoundary
            }
            this.emitTerminalAgentStatusEvents(ptyId, {
              cleanData: '',
              payloads: [payload],
              lastPayloadCleanOffset: null
            })
          }
        }
      }
      state.outputSequence = outputSequence
    })
    state.writeChain = completion.catch(() => {})
  }

  private readPtyAgentStatusRow(
    ptyId: string,
    pty: RuntimePtyWorktreeRecord
  ): AgentStatusIpcPayload | undefined {
    const paneKey =
      this.getLeavesForPty(ptyId).map((leaf) => this.makeRuntimePaneKey(leaf))[0] ??
      this.paneOfPty(pty).paneKey
    return paneKey ? this.getAgentStatusSnapshotForPaneFn?.(paneKey)[0] : undefined
  }
}
