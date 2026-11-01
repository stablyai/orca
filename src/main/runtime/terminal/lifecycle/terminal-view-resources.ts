import type { WaitBlockedCheckState } from '../../wait-blocked-check-state'
import { OrcaRuntimeWithStopRequestedPtyIds } from '../../construction/runtime-service-state'
import { RuntimeSubscriptionRegistry } from '../../runtime-subscription-registry'
import { RuntimeMobileNotificationController } from '../../runtime-mobile-notification-controller'
import type {
  ProviderBufferAcquisition,
  RuntimeHeadlessTerminal,
  RuntimePtyTitleTrackerEntry,
  RuntimePtyWorktreeRecord,
  RuntimeVisibleTerminalState
} from '../../runtime-terminal-state-records'
import type { TerminalKittyKeyboardModeTracker } from '../../../../shared/terminal-kitty-keyboard-mode-tracker'
import type { PtyProviderBufferSnapshot } from '../../../providers/pty-provider-contract'
import type { createAgentStatusOscProcessor } from '../../../../shared/agent-status-osc'
import { RuntimeTerminalViewSubscribers } from '../../runtime-terminal-view-subscribers'
import { MainDaemonAttachments } from './main-daemon-attachments'
import { parseAppSshPtyId } from '../../../../shared/ssh-pty-id'

export abstract class OrcaRuntimeWithFitOverrideListeners extends OrcaRuntimeWithStopRequestedPtyIds {
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

  protected ptysById = new Map<string, RuntimePtyWorktreeRecord>()

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

  protected providerBufferAcquisitionsByPtyId = new Map<string, ProviderBufferAcquisition>()

  protected providerVisibleStateByPtyId = new Map<string, RuntimeVisibleTerminalState>()

  protected providerVisibleStateReadsByPtyId = new Map<
    string,
    { generation: number; promise: Promise<RuntimeVisibleTerminalState | null> }
  >()

  protected providerVisibleRetryAtByPtyId = new Map<string, number>()

  protected providerSnapshotsWithLiveModeTransition = new WeakSet<PtyProviderBufferSnapshot>()

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

  // Desktop mode prevents mobile fit until a deliberate gesture; absent mode defaults to auto, and restart clears modes.
  protected mobileDisplayModes = new Map<string, 'desktop'>()

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
    isUnattachedLocalCandidate: (ptyId) => {
      if (
        this.headlessTerminals.has(ptyId) ||
        this.providerSnapshotPreferredPtys.has(ptyId) ||
        this.pendingPtyRegistrationIncarnations.has(ptyId) ||
        parseAppSshPtyId(ptyId)
      ) {
        return false
      }
      const pty = this.ptysById.get(ptyId)
      return pty !== undefined && pty.connectionId === null && pty.connected
    },
    attachProvider: (ptyId) => this.ptyController?.attach?.(ptyId) ?? null
  })

  // Remote xterms own query replies; ref-count streams and retain suppression through mobile soft-leave grace (terminal-query-authority.md).
  protected readonly terminalViewSubscribers = new RuntimeTerminalViewSubscribers({
    notifyPresenceChanged: (ptyId) => this.notifyRemoteTerminalViewPresenceChanged(ptyId),
    hasMobileSubscribers: (ptyId) => (this.mobileSubscribers.get(ptyId)?.size ?? 0) > 0,
    ensureProviderAttach: (ptyId) => this.mainDaemonAttachments.ensure(ptyId)
  })
}
