import { OrcaRuntimeWithCreateTerminalSideEffectCommandCodeDetector } from './terminal-derived-agent-facts'
import type { AgentStatus } from '../../../../shared/agent-status/title/agent-title-core'
import { getDisplayPromptLifecycle } from '../../workspaces/process-listing/runtime-worktree-status-projection'
import { findLastCompleteOscTitleRange } from './terminal-osc-title-range'
import { extractLastOscTitle } from '../../../../shared/agent-status/title/osc-title-extraction'
import type { RuntimeTerminalDataMeta } from './runtime-terminal-stream-consumers'
import { TerminalPublishedOutputRings } from './terminal-published-output-ring'
import type { RuntimePtyWorktreeRecord } from '../records/runtime-terminal-state-records'
import { readLaunchCommandOutput } from '../wait/launched-agent-exit-watch'
import {
  DAEMON_SESSION_SCROLLBACK_ROWS,
  resolveDaemonSessionScrollbackRows
} from '../../../daemon/sessions/daemon-session-scrollback-window'
import {
  reattachedPaintEntry,
  reattachedPaintLedger,
  retainedFrameIsProven
} from '../wait/reattached-paint-ledger'

export abstract class OrcaRuntimeWithRecordAgentPromptLifecycleState extends OrcaRuntimeWithCreateTerminalSideEffectCommandCodeDetector {
  private readonly ptyLifecycleCancellation = new Map<string, AbortController>()
  private readonly publishedOutputRings = new TerminalPublishedOutputRings()

  protected getPtyLifecycleSignal(ptyId: string): AbortSignal {
    let controller = this.ptyLifecycleCancellation.get(ptyId)
    if (!controller) {
      controller = new AbortController()
      this.ptyLifecycleCancellation.set(ptyId, controller)
    }
    return controller.signal
  }

  protected recordAgentPromptLifecycleState(ptyId: string, status: AgentStatus | null): void {
    if (status === 'permission') {
      this.recordAgentPromptPermissionObservation(ptyId)
    }
    const current = this.agentPromptLifecycleByPtyId.get(ptyId)
    // Why projected: main recorded a stale-working clear here, so the next working status after
    // one starts a new turn for prompt verification, as it did there.
    const previousStatus = getDisplayPromptLifecycle(
      current,
      this.getPtyTitleDisplayClear(ptyId)
    )?.status
    const updatedAt = Date.now()
    if (!current) {
      this.agentPromptLifecycleByPtyId.set(ptyId, {
        status,
        workingSequence: status === 'working' ? 1 : 0,
        updatedAt
      })
      return
    }
    this.agentPromptLifecycleByPtyId.set(ptyId, {
      status,
      workingSequence:
        current.workingSequence + (status === 'working' && previousStatus !== 'working' ? 1 : 0),
      updatedAt
    })
  }

  protected recordAgentPromptPermissionObservation(ptyId: string): void {
    this.agentPromptPermissionSequenceByPtyId.set(
      ptyId,
      (this.agentPromptPermissionSequenceByPtyId.get(ptyId) ?? 0) + 1
    )
  }

  protected restoreAgentPromptLifecycleByteOrder(
    ptyId: string,
    titleInput: string,
    lastPayloadTitleOffset: number | null
  ): void {
    if (lastPayloadTitleOffset === null) {
      return
    }
    const titleRange = findLastCompleteOscTitleRange(titleInput)
    if (!titleRange || titleRange.end <= lastPayloadTitleOffset) {
      return
    }
    const title = extractLastOscTitle(titleInput)
    if (title === null) {
      return
    }
    // Explicit-first, as the title observer classified it: a program's activity outranks the glyph.
    const status = this.classifyPtyTitleStatus(ptyId, title)
    const current = this.agentPromptLifecycleByPtyId.get(ptyId)
    if (!current || current.status === status) {
      return
    }
    this.agentPromptLifecycleByPtyId.set(ptyId, {
      status,
      workingSequence:
        current.workingSequence + (status === 'working' && current.status !== 'working' ? 1 : 0),
      updatedAt: Date.now()
    })
  }

  getPtyOutputSequence(ptyId: string): number {
    return this.ptyOutputSequenceById.get(ptyId) ?? 0
  }

  protected providerHistoryLiveWindowRows(): number {
    return Math.min(resolveDaemonSessionScrollbackRows(), DAEMON_SESSION_SCROLLBACK_ROWS)
  }

  /** The hidden renderer missed any dropped output: once its PTY gaps in a generation it never stands in for the
   *  screen (null). Compare a read's token before and after its IPC, so exit, reuse and stream resets fence it too. */
  protected rendererScreenToken(ptyId: string): number | null {
    return this.ptyGapCounts.has(ptyId) || this.headlessTerminals.get(ptyId)?.gapReseed
      ? null
      : this.getPtyLifecycleGeneration(ptyId)
  }

  protected getPtyLifecycleGeneration(ptyId: string): number {
    const existing = this.ptyLifecycleGenerationById.get(ptyId)
    if (existing !== undefined) {
      return existing
    }
    const generation = this.nextPtyLifecycleGeneration++
    this.ptyLifecycleGenerationById.set(ptyId, generation)
    return generation
  }

  protected advancePtyLifecycleGeneration(ptyId: string): void {
    this.ptyLifecycleGenerationById.set(ptyId, this.nextPtyLifecycleGeneration++)
    this.providerModeSnapshotScansByPtyId.delete(ptyId)
    const cancellation = this.ptyLifecycleCancellation.get(ptyId)
    this.ptyLifecycleCancellation.delete(ptyId)
    cancellation?.abort()
    this.clearAgentPromptCorrelationForPty(ptyId)
    // A stop intent belongs to one process incarnation; never let it label a
    // replacement process when the provider reports a generation reset.
    this.stopRequestedPtyIds.delete(ptyId)
    this.agentPromptLifecycleByPtyId.delete(ptyId)
    this.agentPromptPermissionSequenceByPtyId.delete(ptyId)
    this.agentPromptExplicitStatusFloorByPtyId.set(ptyId, Date.now())
    this.legacyWorkerRecovery.deleteRecoveredPty(ptyId)
    // Why: a respawn under the same session id needs its own main attach.
    this.mainDaemonAttachments.forget(ptyId)
    const pty = this.ptysById.get(ptyId)
    if (pty) {
      pty.outputObservedSince = null
    }
    // Why: a provider response belongs to the process generation that issued
    // it; a respawn must neither reuse its frame nor join its in-flight call.
    this.providerBufferAcquisitionsByPtyId.delete(ptyId)
    this.forgetProviderVisibleState(ptyId)
    // A phone that saw the previous process gets a fresh snapshot, never a resume across the respawn.
    this.resetPublishedTerminalOutputCoverage(ptyId)
  }

  /** Ends resume onto output published so far: the phone's next subscribe gets a snapshot. */
  protected resetPublishedTerminalOutputCoverage(ptyId: string): void {
    this.publishedOutputRings.get(ptyId)?.resetCoverage(this.getPtyOutputSequence(ptyId))
  }

  /** Why: main counts delivered chars, which can drift from the daemon's count across a reattach. */
  anchorProviderSequence(ptyId: string, outputSequence: number, providerSeq: number): void {
    if (!this.providerSequenceInitializedPtys.has(ptyId) || !Number.isFinite(providerSeq)) {
      return
    }
    const offset = outputSequence - providerSeq
    const previous = this.providerSequenceOffsetByPtyId.get(ptyId) ?? 0
    const revision = this.providerSequenceAnchorRevisions.get(ptyId)
    if (revision !== undefined && offset === previous) {
      return
    }
    this.providerSequenceOffsetByPtyId.set(ptyId, offset)
    this.providerSequenceAnchorRevisions.set(
      ptyId,
      offset === previous ? (revision ?? 0) : (revision ?? 0) + 1
    )
    if (revision === undefined) {
      if (offset !== previous) {
        console.warn('[terminal] provider stream position re-anchored', {
          ptyId,
          drift: offset - previous
        })
      }
      this.onProviderSequenceAnchored(ptyId)
    }
  }

  /** The stream's first stamp since sync: from here a provider snapshot can be placed in it. */
  protected onProviderSequenceAnchored(_ptyId: string): void {}

  /** For quit: lets the next run read each agent's retained frame as the paint this run saw. */
  saveReattachedPaintLedger(): Promise<void> {
    const entries = new Map(
      [...this.ptysById].flatMap(([ptyId, pty]) => {
        const offset = this.providerSequenceOffsetByPtyId.get(ptyId) ?? 0
        const sequence = this.providerSequenceInitializedPtys.has(ptyId)
          ? this.getPtyOutputSequence(ptyId) - offset
          : undefined
        const entry = reattachedPaintEntry(pty, sequence)
        return entry ? [[ptyId, entry] as const] : []
      })
    )
    // A terminal this run never attached keeps the entry its last quit saved.
    return reattachedPaintLedger().save(entries, new Set(this.providerSequenceInitializedPtys))
  }

  /** Whether the quit ledger proves the reattached frame is this agent's own last paint. */
  protected async isRetainedFrameProven(ptyId: string, agent: string): Promise<boolean> {
    const entry = await reattachedPaintLedger().read(ptyId)
    return retainedFrameIsProven(entry, {
      incarnationId: this.ptysById.get(ptyId)?.incarnationId ?? null,
      reattachedSequence: this.reattachedProviderSequenceByPtyId.get(ptyId),
      agent
    })
  }

  synchronizePtyOutputSequenceFromProvider(
    ptyId: string,
    providerSequence: { value: number; generation: 'continued' | 'reset' },
    runtimeSequenceAtSpawnStart = 0
  ): number {
    if (
      !Number.isFinite(providerSequence.value) ||
      providerSequence.value < 0 ||
      !Number.isFinite(runtimeSequenceAtSpawnStart) ||
      runtimeSequenceAtSpawnStart < 0
    ) {
      return this.getPtyOutputSequence(ptyId)
    }
    const baseline = Math.floor(providerSequence.value)
    const currentSequence = this.getPtyOutputSequence(ptyId)
    const sequenceAtSpawnStart = Math.min(currentSequence, Math.floor(runtimeSequenceAtSpawnStart))
    const postSpawnSequence = currentSequence - sequenceAtSpawnStart
    const wasInitialized = this.providerSequenceInitializedPtys.has(ptyId)
    const replacesExistingRuntimeGeneration = wasInitialized || sequenceAtSpawnStart > 0
    const providerOffset =
      providerSequence.generation === 'reset'
        ? sequenceAtSpawnStart
        : (this.providerSequenceOffsetByPtyId.get(ptyId) ?? 0)
    const providerBaseline = providerOffset + baseline

    if (providerSequence.generation === 'reset') {
      this.advancePtyLifecycleGeneration(ptyId)
      this.providerSequenceAnchorRevisions.delete(ptyId)
      this.gapRecoveryAwaitingStamp.delete(ptyId)
      // Why: daemon respawn/cold restore starts a new absolute domain. Old
      // emulator state cannot remain authoritative over the replacement.
      if (replacesExistingRuntimeGeneration) {
        this.disposeHeadlessTerminal(ptyId)
        // The replacing stream has had no gap; the generation advance already fences older reads.
        this.ptyGapCounts.delete(ptyId)
      }
      this.providerModeTrackersByPtyId.delete(ptyId)
      this.wslDistroByPtyId.delete(ptyId)
      this.terminalCwdByPtyId.delete(ptyId)
      this.terminalFileUriHostnameByPtyId.delete(ptyId)
      const pty = this.ptysById.get(ptyId)
      if (pty) {
        this.terminalIdentity.setPtyWslDistro(pty, null)
      }
      if (replacesExistingRuntimeGeneration && postSpawnSequence === 0) {
        // The replaced process's live facet says nothing about its successor.
        this.clearLiveProgramStatusFacet(ptyId)
        this.resetTrackedTerminalStateForProviderGeneration(ptyId)
      }
    }

    const synchronizedSequence =
      providerSequence.generation === 'reset'
        ? currentSequence
        : wasInitialized
          ? currentSequence
          : providerBaseline + postSpawnSequence
    this.ptyOutputSequenceById.set(ptyId, synchronizedSequence)
    if (providerSequence.generation === 'continued' && !wasInitialized) {
      this.reattachedProviderSequenceByPtyId.set(ptyId, baseline)
    } else if (providerSequence.generation === 'reset') {
      this.reattachedProviderSequenceByPtyId.delete(ptyId)
    }
    this.providerSequenceInitializedPtys.add(ptyId)
    this.providerSequenceOffsetByPtyId.set(ptyId, providerOffset)

    const snapshotMayCoverMissingState =
      (providerSequence.generation === 'continued' && !wasInitialized) ||
      (postSpawnSequence > 0 &&
        providerSequence.generation === 'reset' &&
        replacesExistingRuntimeGeneration) ||
      (providerSequence.generation === 'continued' &&
        wasInitialized &&
        providerBaseline > currentSequence)
    if (snapshotMayCoverMissingState) {
      // Why: bytes can cross the control/stream sockets around attach. Until a
      // full renderer/provider snapshot is available, a partial model is unsafe.
      this.providerSnapshotPreferredPtys.add(ptyId)
    } else if (providerSequence.generation === 'reset') {
      this.providerSnapshotPreferredPtys.delete(ptyId)
    }

    const headless = this.headlessTerminals.get(ptyId)
    if (headless && !wasInitialized && providerSequence.generation === 'continued') {
      // Why: daemon bytes can reach main just before spawn resolves. Queue the
      // baseline behind those writes so their emulator sequence is rebased too.
      headless.writeChain = headless.writeChain.then(() => {
        headless.outputSequence = synchronizedSequence
      })
    }
    return synchronizedSequence
  }

  subscribeToTerminalData(
    ptyId: string,
    listener: (data: string, meta?: RuntimeTerminalDataMeta) => void
  ): () => void {
    return this.terminalStreamConsumers.subscribe(ptyId, listener)
  }

  /** Keeps this PTY's published output from now on, so a phone stream can later resume from it. */
  retainPublishedTerminalOutput(ptyId: string): ReturnType<TerminalPublishedOutputRings['retain']> {
    return this.publishedOutputRings.retain(ptyId, {
      seq: this.getPtyOutputSequence(ptyId),
      size: () => this.getTerminalSize(ptyId),
      subscribe: (listener) => this.subscribeToTerminalData(ptyId, listener)
    })
  }

  readRecentTerminalOutput(ptyId: string): string | undefined {
    return this.recentPtyOutputById.get(ptyId)?.read()
  }

  /** The exit frees the buffer, so keep what the PTY's last command printed for its start failure. */
  protected releaseRecentPtyOutput(ptyId: string, pty: RuntimePtyWorktreeRecord | undefined): void {
    const recent = this.recentPtyOutputById.get(ptyId)
    // A repeated exit report finds the buffer already freed and keeps what the first one saved.
    if (pty && recent) {
      pty.lastExitOutput = {
        incarnationId: pty.incarnationId,
        text: readLaunchCommandOutput(recent.read(), { ptyExited: true })
      }
    }
    this.recentPtyOutputById.delete(ptyId)
  }

  readExitedLaunchOutput(ptyId: string, incarnationId: string): string | undefined {
    const saved = this.ptysById.get(ptyId)?.lastExitOutput
    return saved?.incarnationId === incarnationId ? saved.text : undefined
  }
}
