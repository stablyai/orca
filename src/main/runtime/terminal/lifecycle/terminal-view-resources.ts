import type {
  TerminalIdentityRawInputs,
  TerminalIdentityReadContext
} from '../query/terminal-identity-read-context'
import type { CrewRuntimeReaders } from '../../orchestration/crew/crew-runtime-watch'
import { TerminalIdentitySource } from '../identity/terminal-identity-source'
import type { WaitBlockedCheckState } from '../wait/wait-blocked-check-state'
import { OrcaRuntimeWithStopRequestedPtyIds } from '../../construction/runtime-service-state'
import { RuntimeSubscriptionRegistry } from '../../client/runtime-subscription-registry'
import { RuntimeMobileNotificationController } from '../../push/notifications/runtime-mobile-notification-controller'
import type {
  ProviderBufferAcquisition,
  RuntimeHeadlessTerminal,
  RuntimePtyTitleTrackerEntry,
  RuntimeVisibleTerminalState
} from '../records/runtime-terminal-state-records'
import type { TerminalKittyKeyboardModeTracker } from '../../../../shared/terminal/protocol/input-modes/terminal-kitty-keyboard-mode-tracker'
import type { PtyProviderBufferSnapshot } from '../../../providers/pty/provider-contract'
import type { createAgentStatusOscProcessor } from '../../../../shared/agent-status/transport/agent-status-osc'
import { RuntimeTerminalViewSubscribers } from '../view/runtime-terminal-view-subscribers'
import { MainDaemonAttachments } from './main-daemon-attachments'
import { parseAppSshPtyId } from '../../../../shared/ssh-pty-id'
import type { RuntimeTerminalProjection } from '../output/terminal-projection'

/** The PTY grid a provider frame was taken for; null while the PTY's size is unknown. */
export type ProviderFrameGrid = { cols: number; rows: number } | null

export function sameProviderFrameGrid(a: ProviderFrameGrid, b: ProviderFrameGrid): boolean {
  return a === b || (a !== null && b !== null && a.cols === b.cols && a.rows === b.rows)
}

/**
 * A frame fits while the PTY is still on the grid its read captured (when one did) and the frame
 * was drawn for that grid. Unknown size keeps today's geometry-blind behavior.
 */
export function providerFrameFitsGrid(
  current: ProviderFrameGrid,
  captured: ProviderFrameGrid | undefined,
  frame: ProviderFrameGrid
): boolean {
  return (
    (captured === undefined || sameProviderFrameGrid(current, captured)) &&
    (current === null || sameProviderFrameGrid(current, frame))
  )
}

/** A provider acquisition; `visibleRetired` marks a grid change since it began, which visible reads must not inherit. */
export type ProviderVisibleAcquisition = ProviderBufferAcquisition & {
  grid?: ProviderFrameGrid
  visibleRetired?: true
}

/** One provider capture a visible read owns, with the one parse every waiter shares. */
export type ProviderVisibleCapture = {
  raw: Promise<PtyProviderBufferSnapshot | null>
  parsed?: Promise<RuntimeTerminalProjection>
  settled: boolean
  // Only an actual null answer permits the one further capture; a settled frame is reused.
  answeredNull?: true
  // The primary stage reading this capture; an earlier capture's null never answers a newer one.
  primary?: Promise<RuntimeVisibleTerminalState | null>
}

/**
 * One visible read operation: it owns its source selection, captures, parse and publication.
 * Shared stages carry no caller deadline; each caller bounds its own wait over them.
 */
export type ProviderVisibleRead = {
  generation: number
  grid: ProviderFrameGrid
  currentFrame: boolean
  // Set on this exact object when it stops being current; equal numbers later never clear it.
  retired?: true
  capture?: ProviderVisibleCapture
  // Captures issued or adopted: a primary and at most one fallback.
  attempts: number
  fallback?: Promise<RuntimeTerminalProjection | null>
  // Unsettled stages, captures, parses and caller holds; the entry leaves the map at zero.
  pending: number
}

export abstract class OrcaRuntimeWithFitOverrideListeners extends OrcaRuntimeWithStopRequestedPtyIds {
  protected readonly terminalIdentity = new TerminalIdentitySource(this.crewChanges.notify)
  protected readonly ptysById = this.terminalIdentity.ptys
  readonly handles = this.terminalIdentity.handles
  protected readonly handleByLeafKey = this.terminalIdentity.leafHandles
  protected readonly handleByPtyId = this.terminalIdentity.reverse
  protected readonly handleByPtyIncarnation = this.terminalIdentity.incarnations
  protected readonly syntheticTerminalHandles = this.terminalIdentity.synthetic
  protected get leaves() {
    return this.terminalIdentity.leaves
  }
  protected get tabs() {
    return this.terminalIdentity.tabs
  }
  protected get graphSequence() {
    return this.terminalIdentity.graphSequence
  }
  protected get rendererGraphEpoch() {
    return this.terminalIdentity.rendererGraphEpoch
  }

  abstract getLiveTerminalPaneKey(
    handle: string,
    context?: TerminalIdentityReadContext
  ): string | null
  abstract createTerminalIdentityRawInputs(): TerminalIdentityRawInputs
  abstract createTerminalIdentityReadContext(
    inputs?: TerminalIdentityRawInputs
  ): TerminalIdentityReadContext

  abstract getNestedWorkerMaxDepth(): number

  protected crewRuntimeReaders(): CrewRuntimeReaders {
    return {
      getNestedWorkerMaxDepth: this.getNestedWorkerMaxDepth.bind(this),
      getOrchestrationDispatchAuthority: this.getOrchestrationDispatchAuthority.bind(this),
      getLiveTerminalPaneKey: this.getLiveTerminalPaneKey.bind(this),
      getTerminalWorktreeIdForHandle: this.getTerminalWorktreeIdForHandle.bind(this),
      getTerminalProcessIncarnation: this.getTerminalProcessIncarnation.bind(this),
      getTerminalHandleForPaneKey: this.getTerminalHandleForPaneKey.bind(this),
      getPaneKeyForTerminalHandle: this.getPaneKeyForTerminalHandle.bind(this),
      getTerminalPaneKey: this.getTerminalPaneKey.bind(this),
      getOrchestrationFleetAgentStatusSnapshot:
        this.getOrchestrationFleetAgentStatusSnapshot.bind(this),
      createTerminalIdentityRawInputs: this.createTerminalIdentityRawInputs.bind(this),
      createTerminalIdentityReadContext: this.createTerminalIdentityReadContext.bind(this),
      orchestrationSenderNames: this.orchestrationSenderNames
    }
  }

  protected abstract notifyRemoteTerminalViewPresenceChanged(ptyId: string): void

  // Notify mobile when desktop restores fit, including disconnect and exit paths.
  protected fitOverrideListeners = new Map<
    string,
    Set<
      (event: {
        mode: 'mobile-fit' | 'remote-desktop-fit' | 'desktop-fit'
        cols: number
        rows: number
      }) => void
    >
  >()

  protected readonly subscriptions = new RuntimeSubscriptionRegistry()

  protected readonly mobileNotifications = new RuntimeMobileNotificationController()

  protected readonly pairedRendererSessionOwnedPtyIds = new Set<string>()

  protected wslDistroByPtyId = new Map<string, string>()

  protected titleObservationSequence = 0

  protected headlessTerminals = new Map<string, RuntimeHeadlessTerminal>()

  protected ptyOutputSequenceById = new Map<string, number>()

  protected providerSequenceInitializedPtys = new Set<string>()

  protected providerSequenceOffsetByPtyId = new Map<string, number>()

  protected providerSnapshotPreferredPtys = new Set<string>()

  protected providerModeTrackersByPtyId = new Map<string, TerminalKittyKeyboardModeTracker>()

  protected providerModeSnapshotScansByPtyId = new Map<
    string,
    Set<TerminalKittyKeyboardModeTracker>
  >()

  // Deep history may still join a visible-retired acquisition; a visible read may not.
  protected providerBufferAcquisitionsByPtyId = new Map<string, ProviderVisibleAcquisition>()

  // Current-frame reads never join or inherit a deep or timed-out history acquisition.
  protected providerFrameAcquisitionsByPtyId = new Map<string, ProviderVisibleAcquisition>()

  // Each frame keeps the grid it was drawn for and the kind of read that took it.
  protected providerVisibleStateByPtyId = new Map<
    string,
    { state: RuntimeVisibleTerminalState; grid: ProviderFrameGrid; currentFrame: boolean }
  >()

  protected providerVisibleStateReadsByPtyId = new Map<string, ProviderVisibleRead>()

  protected providerVisibleRetryAtByPtyId = new Map<string, number>()

  /** PTYs whose screen has shown no agent dialog since this runtime attached; their restored permission waits are spent. */
  protected restoredAgentDialogRuledOutPtys = new Set<string>()

  protected providerSnapshotsWithLiveModeTransition = new WeakSet<PtyProviderBufferSnapshot>()

  /** Forgets the provider frame facts of a PTY whose screen restarts or ends. */
  protected forgetProviderVisibleState(ptyId: string): void {
    this.providerVisibleStateByPtyId.delete(ptyId)
    this.providerFrameAcquisitionsByPtyId.delete(ptyId)
    this.providerVisibleRetryAtByPtyId.delete(ptyId)
    this.retireProviderVisibleRead(ptyId)
    this.restoredAgentDialogRuledOutPtys.delete(ptyId)
  }

  /** A grid change outdates every frame taken, or being taken, for the old grid. */
  protected forgetProviderFramesForGrid(ptyId: string): void {
    this.providerVisibleStateByPtyId.delete(ptyId)
    this.providerFrameAcquisitionsByPtyId.delete(ptyId)
    this.retireProviderVisibleRead(ptyId)
    const ordinary = this.providerBufferAcquisitionsByPtyId.get(ptyId)
    if (ordinary) {
      ordinary.visibleRetired = true
    }
  }

  /** Every continuation of the current visible read, wherever it is waiting, stops being current. */
  protected retireProviderVisibleRead(ptyId: string): void {
    const entry = this.providerVisibleStateReadsByPtyId.get(ptyId)
    if (entry) {
      entry.retired = true
      this.providerVisibleStateReadsByPtyId.delete(ptyId)
    }
  }

  protected ptyLifecycleGenerationById = new Map<string, number>()

  protected nextPtyLifecycleGeneration = 1

  // Coalesce tail scans without losing the final chunk in a burst.
  protected waitBlockedCheckStateByPtyId = new Map<string, WaitBlockedCheckState>()

  // OSC 9999 status frames can span PTY chunks.
  protected agentStatusOscProcessorsByPtyId = new Map<
    string,
    ReturnType<typeof createAgentStatusOscProcessor>
  >()

  // PTYs whose last OSC 7501 facet dies with the program; their exit must clear it.
  protected liveProgramStatusFacetPtyIds = new Set<string>()

  // Track every title in order so coalesced working-to-idle transitions and stale-working timers match renderer behavior (#1083).
  protected ptyTitleTrackersByPtyId = new Map<string, RuntimePtyTitleTrackerEntry>()

  // Seed Command Code detection from launch commands; banners cover user-typed launches.
  protected terminalSpawnCommandsByPtyId = new Map<string, string>()

  // Carry split OSC titles across chunks, including SSH buffering, before feeding the title tracker.
  protected oscTitleScanTailByPtyId = new Map<string, string>()

  // OSC 7 carries live host cwd for relative mobile file taps.
  protected osc7ScanTailByPtyId = new Map<string, string>()

  protected terminalCwdByPtyId = new Map<string, string>()

  protected terminalFileUriHostnameByPtyId = new Map<string, string>()

  // Guard one hydration per PTY: pending serializes live writes, done includes skipped attempts (docs/mobile-prefer-renderer-scrollback.md).
  protected headlessHydrationState = new Map<string, 'pending' | 'done'>()

  // Key transient fit overrides by stable PTY, not reissued handle; restart must drop them.
  protected terminalFitOverrides = new Map<
    string,
    {
      mode: 'mobile-fit'
      cols: number
      rows: number
      previousCols: number | null
      previousRows: number | null
      updatedAt: number
      clientId: string
    }
  >()

  // Desktop mode prevents mobile fit until a deliberate gesture; absent mode uses the host default, and restart clears modes.
  protected mobileDisplayModes = new Map<string, 'auto' | 'desktop'>()

  // Keep independent client records per PTY; subscribedAt selects restore baseline, lastActedAt selects the active viewport (docs/mobile-presence-lock.md).
  protected mobileSubscribers = new Map<
    string,
    Map<
      string,
      {
        clientId: string
        viewport: { cols: number; rows: number } | null
        wasResizedToPhone: boolean
        previousCols: number | null
        previousRows: number | null
        subscribedAt: number
        lastActedAt: number
      }
    >
  >()

  protected readonly mainDaemonAttachments = new MainDaemonAttachments({
    isAttachableLocalSession: (ptyId) => {
      if (this.pendingPtyRegistrationIncarnations.has(ptyId) || parseAppSshPtyId(ptyId)) {
        return false
      }
      const pty = this.ptysById.get(ptyId)
      return pty !== undefined && pty.connectionId === null && pty.connected
    },
    hasMainTerminalState: (ptyId) =>
      this.headlessTerminals.has(ptyId) || this.providerSnapshotPreferredPtys.has(ptyId),
    attachProvider: (ptyId) => this.ptyController?.attach?.(ptyId) ?? null
  })

  // Remote xterms own query replies; ref-count streams and retain suppression through mobile soft-leave grace (terminal-query-authority.md).
  protected readonly terminalViewSubscribers = new RuntimeTerminalViewSubscribers({
    notifyPresenceChanged: (ptyId) => this.notifyRemoteTerminalViewPresenceChanged(ptyId),
    hasMobileSubscribers: (ptyId) => (this.mobileSubscribers.get(ptyId)?.size ?? 0) > 0,
    ensureProviderAttach: (ptyId) => this.mainDaemonAttachments.ensure(ptyId)
  })
}
