import type { ProcessedAgentStatusChunk } from '../../../../shared/agent-status-osc'
import type {
  RuntimePtyWorktreeRecord,
  RuntimeLeafRecord,
  RuntimePtyTitleTrackerEntry
} from '../../runtime-terminal-state-records'
import type { RuntimeSyncedLeaf } from '../../../../shared/runtime-types'
import { OrcaRuntimeWithPreparePtyExecutionContext } from '../launch/terminal-execution-context'
import { advertisedUrlWatcher } from '../../../ports/advertised-url-watcher'
import { appendNormalizedToTailBuffer } from '../../terminal-tail-buffer'
import { normalizeTerminalChunk } from '../../terminal-ansi-normalization'
import { observeTerminalCommandPaint } from '../../terminal-command-paint'
import {
  appendCompletedTerminalTranscript,
  buildPreview,
  tailStateMatches
} from '../../terminal-tail-state'
import {
  computeTerminalTailWaitState,
  tailGainedNewerBlockedReason
} from '../../terminal-wait-tail-state'
import { extractOscTitleScanTail } from '../../../../shared/osc-title-scan-tail'

export abstract class OrcaRuntimeWithOnPtyData extends OrcaRuntimeWithPreparePtyExecutionContext {
  protected abstract recordOsc7MetadataForPty(
    ptyId: string,
    data: string
  ): { cwd: string | null; cwdChanged: boolean }
  protected abstract processAgentStatusOscForPty(
    ptyId: string,
    data: string
  ): ProcessedAgentStatusChunk
  protected abstract recordRecentPtyOutput(ptyId: string, data: string): void
  protected abstract shouldAnswerQueriesForLiveChunk(ptyId: string): boolean
  abstract maybeHydrateHeadlessFromRenderer(ptyId: string): Promise<boolean> | null
  protected abstract trackHeadlessTerminalData(
    ptyId: string,
    data: string,
    outputSequence: number,
    forwardQueryReplies?: boolean
  ): void
  protected abstract getOrCreatePtyWorktreeRecord(ptyId: string): RuntimePtyWorktreeRecord | null
  protected abstract scheduleWaitBlockedCheck(ptyId: string, appendedText: string, at: number): void
  protected abstract getLeavesForPty(ptyId: string): RuntimeLeafRecord[]
  protected abstract recordPtyWorktree(
    ptyId: string,
    worktreeId: string,
    state?: Partial<
      Pick<
        RuntimePtyWorktreeRecord,
        | 'connected'
        | 'lastOutputAt'
        | 'preview'
        | 'tabId'
        | 'paneKey'
        | 'surfaceRecordedAtGraphSequence'
        | 'title'
        | 'connectionId'
        | 'runtimeSessionOwned'
        | 'isWsl'
        | 'wslDistro'
        | 'incarnationId'
        | 'agentSessionOwners'
      >
    >
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
    const outputSequence = (this.ptyOutputSequenceById.get(ptyId) ?? 0) + sequenceChars
    this.ptyOutputSequenceById.set(ptyId, outputSequence)
    this.scanProviderModeTrackers(ptyId, data)
    const osc7Metadata = this.recordOsc7MetadataForPty(ptyId, data)
    const cwd = osc7Metadata.cwd
    const cwdChanged = osc7Metadata.cwdChanged
    const agentStatusChunk = this.processAgentStatusOscForPty(ptyId, data)
    this.recordRecentPtyOutput(ptyId, data)
    // Use advertised dev-server URLs for workspace ports instead of kernel bind addresses.
    advertisedUrlWatcher.ingest(ptyId, data, at)
    // Capture query ownership in the ingestion/drop tick; queued writes must not reinterpret later subscriber/settings changes.
    const forwardQueryReplies = this.shouldAnswerQueriesForLiveChunk(ptyId)
    // Hydrate before tracking live data: publish the seeded state/chain first or a late seed could overwrite live bytes.
    this.maybeHydrateHeadlessFromRenderer(ptyId)
    // The shared tracker processes every title in byte order, preserving coalesced working-to-idle transitions (#1083).
    this.trackHeadlessTerminalData(ptyId, data, outputSequence, forwardQueryReplies)

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
      pty.connected = true
      pty.disconnectedAt = null
      pty.lastOutputAt = at
      const normalized = normalizeTerminalChunk(data, pty.tailPendingAnsi)
      ptyNormalized = normalized
      pty.tailPendingAnsi = normalized.pendingAnsi
      observeTerminalCommandPaint(pty, data, normalized.text)
      const nextTail = appendNormalizedToTailBuffer(
        pty.tailBuffer,
        pty.tailPartialLine,
        normalized.text,
        pty.tailRedrawCursor
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
      pty.tailRedrawCursor = nextTail.redrawCursor
      pty.tailTruncated = pty.tailTruncated || nextTail.truncated || nextTranscript.truncated
      pty.tailLinesTotal += nextTail.newCompleteLines
      pty.preview = buildPreview(pty.tailBuffer, pty.tailPartialLine)
      this.scheduleWaitBlockedCheck(ptyId, normalized.text, at)
    }

    for (const leaf of this.getLeavesForPty(ptyId)) {
      this.recordPtyWorktree(ptyId, leaf.worktreeId, {
        connected: true,
        lastOutputAt: pty?.lastOutputAt ?? at,
        preview: pty?.preview ?? leaf.preview,
        tabId: leaf.tabId,
        paneKey: this.makeRuntimePaneKey(leaf),
        surfaceRecordedAtGraphSequence: this.graphSequence
      })
      leaf.connected = true
      leaf.writable = this.graphStatus === 'ready'
      leaf.lastOutputAt = at
      if (
        pty &&
        ptyTailBefore &&
        ptyTailAfter &&
        tailStateMatches(
          leaf.tailBuffer,
          leaf.tailTranscriptBuffer,
          leaf.tailPartialLine,
          leaf.tailPendingAnsi,
          leaf.tailRedrawCursor,
          leaf.tailTruncated,
          leaf.tailLinesTotal,
          ptyTailBefore
        )
      ) {
        // Why: the leaf and PTY record usually mirror the same terminal. Reuse
        // the PTY tail update instead of splitting large output twice.
        leaf.tailBuffer = pty.tailBuffer
        leaf.tailTranscriptBuffer = pty.tailTranscriptBuffer
        leaf.tailTranscriptChars = pty.tailTranscriptChars
        leaf.tailPartialLine = pty.tailPartialLine
        leaf.tailPendingAnsi = pty.tailPendingAnsi
        leaf.tailRedrawCursor = pty.tailRedrawCursor
        leaf.tailTruncated = pty.tailTruncated
        leaf.tailLinesTotal = pty.tailLinesTotal
        leaf.preview = pty.preview
        leaf.waitBlockedAt = pty.waitBlockedAt
        // The PTY wait scan is throttled; copying undefined invalidates the leaf cache for exact recomputation next chunk.
        leaf.tailWaitState = pty.tailWaitState
      } else {
        // Why: the same carried escape prefix normalizes the same chunk identically.
        const normalized =
          ptyNormalized && ptyTailBefore?.pendingAnsi === leaf.tailPendingAnsi
            ? ptyNormalized
            : normalizeTerminalChunk(data, leaf.tailPendingAnsi)
        leaf.tailPendingAnsi = normalized.pendingAnsi
        const previousWaitState =
          leaf.tailWaitState?.fromTail === true
            ? leaf.tailWaitState
            : computeTerminalTailWaitState(leaf.tailBuffer, leaf.tailPartialLine, leaf.preview)
        const nextTail = appendNormalizedToTailBuffer(
          leaf.tailBuffer,
          leaf.tailPartialLine,
          normalized.text,
          leaf.tailRedrawCursor
        )
        const nextTranscript = appendCompletedTerminalTranscript(
          leaf.tailTranscriptBuffer,
          leaf.tailTranscriptChars,
          nextTail.newlyCompletedLines,
          nextTail.newCompleteLines
        )
        const nextWaitState = computeTerminalTailWaitState(
          nextTail.lines,
          nextTail.partialLine,
          leaf.preview
        )
        if (tailGainedNewerBlockedReason(previousWaitState, nextWaitState, normalized.text)) {
          leaf.waitBlockedAt = at
        }
        leaf.tailWaitState = nextWaitState
        leaf.tailBuffer = nextTail.lines
        leaf.tailTranscriptBuffer = nextTranscript.lines
        leaf.tailTranscriptChars = nextTranscript.characters
        leaf.tailPartialLine = nextTail.partialLine
        leaf.tailRedrawCursor = nextTail.redrawCursor
        leaf.tailTruncated = leaf.tailTruncated || nextTail.truncated || nextTranscript.truncated
        leaf.tailLinesTotal += nextTail.newCompleteLines
        leaf.preview = buildPreview(leaf.tailBuffer, leaf.tailPartialLine)
      }
    }

    // Feed cleanData titles in byte order so coalesced transitions reach waits/delivery; pure OSC 9999 status chunks must not disturb stale-title probes.
    const titleTrackerEntry = this.getOrCreatePtyTitleTrackerEntry(ptyId)
    const previousTitleScanTail = this.oscTitleScanTailByPtyId.get(ptyId)
    const titleInput = previousTitleScanTail
      ? `${previousTitleScanTail}${agentStatusChunk.cleanData}`
      : agentStatusChunk.cleanData
    const nextTitleScanTail = extractOscTitleScanTail(titleInput)
    if (nextTitleScanTail.length > 0) {
      this.oscTitleScanTailByPtyId.set(ptyId, nextTitleScanTail)
    } else {
      this.oscTitleScanTailByPtyId.delete(ptyId)
    }
    titleTrackerEntry.applyingChunk = true
    titleTrackerEntry.chunkTouchedSessionTabs = false
    try {
      for (const payload of agentStatusChunk.payloads) {
        titleTrackerEntry.pendingFacts.push({ kind: 'agent-status', payload })
      }
      // Background CLI PTYs may lack pane keys; retain first-party status on the always-addressable PTY record.
      const latestAgentStatus = agentStatusChunk.payloads.at(-1)
      if (latestAgentStatus) {
        const ptyRecord = this.ptysById.get(ptyId)
        if (ptyRecord) {
          ptyRecord.lastExplicitAgentStatus = {
            state: latestAgentStatus.state,
            updatedAt: Date.now(),
            sessionBoundary: latestAgentStatus.sessionBoundary,
            ...(latestAgentStatus.state === 'done' &&
            agentStatusChunk.programStatusPayloads?.has(latestAgentStatus)
              ? { programAtRest: true }
              : {})
          }
        }
      }
      titleTrackerEntry.tracker.handleChunk(agentStatusChunk.cleanData, {
        titleScanData: titleInput,
        programActivity: agentStatusChunk.programActivity
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
            : (previousTitleScanTail?.length ?? 0) + agentStatusChunk.lastPayloadCleanOffset
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
