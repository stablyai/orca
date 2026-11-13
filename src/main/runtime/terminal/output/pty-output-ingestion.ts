import { appendTerminalLeafOutput } from './terminal-leaf-output'
import type { TerminalOriginRuns } from '../../../../shared/terminal/output/terminal-content-origin'
import type { OrcaRuntimeWithRecordPtyWorktree } from '../identity/pty-worktree-record'
import { observeTerminalActionStatus } from './terminal-action-status'
import type { ProcessedAgentStatusChunk } from '../../../../shared/agent-status/transport/agent-status-osc'
import type {
  RuntimePtyWorktreeRecord,
  RuntimeLeafRecord,
  RuntimePtyTitleTrackerEntry
} from '../records/runtime-terminal-state-records'
import type { RuntimeSyncedLeaf } from '../../../../shared/runtime-session-contracts'
import { OrcaRuntimeWithPreparePtyExecutionContext } from '../launch/terminal-execution-context'
import { advertisedUrlWatcher } from '../../../ports/advertised-url-watcher'
import { appendNormalizedToTailBuffer } from './tail/terminal-tail-buffer'
import { normalizeTerminalChunk } from './terminal-ansi-normalization'
import {
  observeTerminalCommandPaint,
  type TerminalCommandPaint
} from '../input/terminal-command-paint'
import { appendCompletedTerminalTranscript, buildPreview } from './tail/terminal-tail-state'
import {
  advanceTerminalTitleInput,
  terminalTitleOriginObserver
} from './terminal-output-title-input'

export abstract class OrcaRuntimeWithOnPtyData extends OrcaRuntimeWithPreparePtyExecutionContext {
  abstract readKnownTerminalAlternateScreen(ptyId: string): boolean | undefined
  protected abstract clearAgentPromptCorrelationForPty(ptyId: string): void
  protected abstract recordOsc7MetadataForPty(
    ptyId: string,
    data: string
  ): { cwd: string | null; cwdChanged: boolean }
  protected abstract processAgentStatusOscForPty(
    ptyId: string,
    data: string,
    readinessBoundary?: number
  ): ProcessedAgentStatusChunk
  protected abstract recordRecentPtyOutput(ptyId: string, data: string): void
  protected abstract shouldAnswerQueriesForLiveChunk(ptyId: string): boolean
  abstract maybeHydrateHeadlessFromRenderer(ptyId: string): Promise<boolean> | null
  protected abstract trackHeadlessTerminalData(
    ptyId: string,
    data: string,
    outputSequence: number,
    forwardQueryReplies?: boolean,
    isCurrentAction?: () => boolean,
    actionBoundary?: number,
    contentScopes?: TerminalCommandPaint['chunkScopes']
  ): void
  protected abstract getOrCreatePtyWorktreeRecord(ptyId: string): RuntimePtyWorktreeRecord | null
  protected abstract scheduleWaitBlockedCheck(
    ptyId: string,
    appendedText: string,
    at: number,
    origins?: TerminalOriginRuns
  ): void
  protected abstract getLeavesForPty(ptyId: string): readonly RuntimeLeafRecord[]
  protected abstract recordPtyWorktree(
    ...args: Parameters<OrcaRuntimeWithRecordPtyWorktree['recordPtyWorktree']>
  ): RuntimePtyWorktreeRecord
  protected abstract makeRuntimePaneKey(
    leaf: Pick<RuntimeSyncedLeaf, 'tabId' | 'leafId' | 'paneRuntimeId'>
  ): string
  protected abstract getOrCreatePtyTitleTrackerEntry(ptyId: string): RuntimePtyTitleTrackerEntry
  protected abstract emitTerminalAgentStatusEvents(
    ptyId: string,
    chunk: Pick<ProcessedAgentStatusChunk, 'payloads'> & Partial<ProcessedAgentStatusChunk>,
    provenance?: { origin: 'process'; yieldsToHookSince: number }
  ): void
  protected abstract restoreAgentPromptLifecycleByteOrder(
    ptyId: string,
    titleInput: string,
    lastPayloadTitleOffset: number | null
  ): void
  protected abstract flushPendingTerminalSideEffectFacts(
    ptyId: string,
    entry: RuntimePtyTitleTrackerEntry
  ): void

  /** Arrival-order mode scan: the settled tracker plus any in-flight snapshot capture's. */
  protected scanProviderModeTrackers(ptyId: string, data: string): void {
    this.providerModeTrackersByPtyId.get(ptyId)?.scan(data)
    for (const tracker of this.providerModeSnapshotScansByPtyId.get(ptyId) ?? []) {
      tracker.scan(data)
    }
  }

  onPtyData(
    ptyId: string,
    data: string,
    at: number,
    sequenceChars = data.length,
    transformed = false
  ): number {
    const initialAlternateScreen = this.readKnownTerminalAlternateScreen(ptyId)
    const outputSequence = (this.ptyOutputSequenceById.get(ptyId) ?? 0) + sequenceChars
    this.ptyOutputSequenceById.set(ptyId, outputSequence)
    this.scanProviderModeTrackers(ptyId, data)
    const osc7Metadata = this.recordOsc7MetadataForPty(ptyId, data)
    const cwd = osc7Metadata.cwd
    const cwdChanged = osc7Metadata.cwdChanged
    this.recordRecentPtyOutput(ptyId, data)
    // Use advertised dev-server URLs for workspace ports instead of kernel bind addresses.
    advertisedUrlWatcher.ingest(ptyId, data, at)
    // Capture query ownership in the ingestion/drop tick; queued writes must not reinterpret later subscriber/settings changes.
    const forwardQueryReplies = this.shouldAnswerQueriesForLiveChunk(ptyId)
    // Hydrate before tracking live data: publish the seeded state/chain first or a late seed could overwrite live bytes.
    this.maybeHydrateHeadlessFromRenderer(ptyId)
    // The shared tracker processes every title in byte order, preserving coalesced working-to-idle transitions (#1083).

    const pty = this.getOrCreatePtyWorktreeRecord(ptyId)
    const ptyTailBefore = pty
      ? {
          lines: pty.tailBuffer,
          transcriptLines: pty.tailTranscriptBuffer,
          partialLine: pty.tailPartialLine,
          pendingAnsi: pty.tailPendingAnsi,
          redrawCursor: pty.tailRedrawCursor,
          truncated: pty.tailTruncated,
          linesTotal: pty.tailLinesTotal
        }
      : null
    let ptyTailAfter: ReturnType<typeof appendNormalizedToTailBuffer> | null = null
    let ptyNormalized: ReturnType<typeof normalizeTerminalChunk> | null = null
    if (pty) {
      this.terminalIdentity.setPtyConnected(pty, true)
      pty.disconnectedAt = null
      pty.lastOutputAt = at
      observeTerminalCommandPaint(pty, data, undefined, {
        alternateScreen: initialAlternateScreen,
        onBoundary: (boundary) => {
          this.ptyForegroundAgent.startup.forget(ptyId, true)
          this.retireAgentPromptOperationsForBoundary(ptyId, boundary)
          this.orchestrationMailboxNotifications.retirePty(ptyId)
          this.wakeInterestedTerminalDelivery(ptyId)
        }
      })
      const paint = pty.commandPaint!
      const normalized = normalizeTerminalChunk(data, pty.tailPendingAnsi, {
        chunk: paint.chunkOrigins(data.length),
        pending: pty.tailPendingOrigins
      })
      ptyNormalized = normalized
      pty.tailPendingAnsi = normalized.pendingAnsi
      pty.tailPendingOrigins = normalized.pendingOrigins
      paint.observeVisible(data, normalized.text)
      const nextTail = appendNormalizedToTailBuffer(
        pty.tailBuffer,
        pty.tailPartialLine,
        normalized.text,
        pty.tailRedrawCursor,
        { partial: pty.tailPartialOrigins ?? [], chunk: normalized.origins ?? [] }
      )
      ptyTailAfter = nextTail
      const nextTranscript = appendCompletedTerminalTranscript(
        pty.tailTranscriptBuffer,
        pty.tailTranscriptChars,
        nextTail.newlyCompletedLines,
        nextTail.newCompleteLines
      )
      pty.tailBuffer = nextTail.lines
      pty.tailTranscriptBuffer = nextTranscript.lines
      pty.tailTranscriptChars = nextTranscript.characters
      pty.tailPartialLine = nextTail.partialLine
      pty.tailPartialOrigins = nextTail.partialOrigins
      pty.tailRedrawCursor = nextTail.redrawCursor
      pty.tailTruncated = pty.tailTruncated || nextTail.truncated || nextTranscript.truncated
      pty.tailLinesTotal += nextTail.newCompleteLines
      pty.preview = buildPreview(pty.tailBuffer, pty.tailPartialLine)
      this.scheduleWaitBlockedCheck(ptyId, normalized.text, at, normalized.origins)
    }

    const actionBoundary = pty?.commandPaint?.lastBoundaryEnd ?? -1
    const agentStatusChunk = this.processAgentStatusOscForPty(ptyId, data, actionBoundary)
    this.trackHeadlessTerminalData(
      ptyId,
      data,
      outputSequence,
      forwardQueryReplies,
      this.ptyForegroundAgent.captureGeneration(ptyId),
      actionBoundary,
      pty?.commandPaint?.chunkScopes
    )

    for (const leaf of this.getLeavesForPty(ptyId)) {
      this.recordPtyWorktree(ptyId, leaf.worktreeId, {
        connected: true,
        lastOutputAt: pty?.lastOutputAt ?? at,
        preview: pty?.preview ?? leaf.preview,
        tabId: leaf.tabId,
        paneKey: this.makeRuntimePaneKey(leaf),
        surfaceRecordedAtGraphSequence: this.graphSequence
      })
      this.terminalIdentity.updateLeafConnected(leaf, true)
      leaf.writable = this.graphStatus === 'ready'
      leaf.lastOutputAt = at
      appendTerminalLeafOutput(leaf, pty, ptyTailBefore, ptyTailAfter, ptyNormalized, data, at)
    }

    // Feed cleanData titles in byte order so coalesced transitions reach waits/delivery; pure OSC 9999 status chunks must not disturb stale-title probes.
    const titleTrackerEntry = this.getOrCreatePtyTitleTrackerEntry(ptyId)
    const { titleInput, previousLength } = advanceTerminalTitleInput(
      this.oscTitleScanTailByPtyId,
      ptyId,
      agentStatusChunk.cleanData
    )
    titleTrackerEntry.applyingChunk = true
    titleTrackerEntry.chunkTouchedSessionTabs = false
    try {
      for (const payload of agentStatusChunk.payloads) {
        titleTrackerEntry.pendingFacts.push({ kind: 'agent-status', payload })
      }
      const actionPty = this.ptysById.get(ptyId)
      if (actionPty) {
        observeTerminalActionStatus(actionPty, agentStatusChunk)
      }
      titleTrackerEntry.tracker.handleChunk(agentStatusChunk.cleanData, {
        initialAlternateScreen,
        titleScanData: titleInput,
        programActivity: agentStatusChunk.programActivity,
        onObservedTitle: terminalTitleOriginObserver(
          pty?.commandPaint,
          agentStatusChunk.rawOffsetAt
        )
      })
      // Keep Command Code facts in this chunk's batch; exclude OSC 9999 payloads from its bounded text window.
      titleTrackerEntry.commandCodeDetector?.observe(agentStatusChunk.cleanData)
    } finally {
      titleTrackerEntry.applyingChunk = false
      try {
        // Cross-channel order is status, titles, bell; publish agentStatus:set before pty:sideEffect.
        this.emitTerminalAgentStatusEvents(ptyId, agentStatusChunk)
        const lastPayloadTitleOffset =
          agentStatusChunk.lastPayloadCleanOffset === null
            ? null
            : previousLength + agentStatusChunk.lastPayloadCleanOffset
        this.restoreAgentPromptLifecycleByteOrder(ptyId, titleInput, lastPayloadTitleOffset)
      } finally {
        // Always flush, even after tracker exceptions, so facts cannot leak into the next chunk's seq.
        this.flushPendingTerminalSideEffectFacts(ptyId, titleTrackerEntry)
      }
    }
    // OSC 9999 already republishes via store changes; only title changes need another session publish.
    if (titleTrackerEntry.chunkTouchedSessionTabs) {
      this.touchMobileSessionSnapshotsForPty(ptyId)
    }

    this.terminalStreamConsumers.publish(ptyId, data, () => ({
      seq: outputSequence,
      rawLength: sequenceChars,
      ...(transformed ? { transformed: true } : {}),
      ...(cwdChanged && cwd !== null ? { cwd } : {})
    }))
    return outputSequence
  }
}
