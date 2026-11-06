import { setTimeout as delay } from 'node:timers/promises'
import { OrcaRuntimeWithRecordAgentPromptLifecycleState } from '../output/terminal-output-generation'
import type { TerminalOscLinkRange } from '../../../../shared/terminal/links/terminal-osc-link-ranges'
import type { PtyProviderBufferSnapshot } from '../../../providers/pty-provider-contract'
import type { RuntimeTerminalWriteOptions } from '../input/runtime-terminal-writer'
import type { WriteSettlement } from '../../../../shared/terminal/pty/lifecycle/pty-write-settlement'

import type { RuntimeTerminalDriverState as DriverState } from '../../../../shared/runtime-session-contracts'
import { addListenerToMap } from './terminal-listener-map'
import { notifyRuntimeListeners } from '../../events/runtime-listener-delivery'
import type { RuntimeTerminalAttention } from '../../../../shared/runtime-terminal-contracts'
import type { RuntimeTerminalBufferSnapshot } from '../records/runtime-terminal-state-records'
import { AUTHORITATIVE_TERMINAL_SNAPSHOT_TIMEOUT_MS } from '../output/provider-snapshot-budget'
import { assertTerminalInputWithinLimitWithYield } from '../../terminal-send-payload'
import { TerminalViewerDevices } from './terminal-viewer-devices'

// Covers a daemon reconnect plus the attach; past it the write proceeds and is refused as before.
const ENDPOINT_REATTACH_INPUT_WAIT_MS = 10_000

export abstract class OrcaRuntimeWithNotifyRemoteTerminalViewPresenceChanged extends OrcaRuntimeWithRecordAgentPromptLifecycleState {
  protected abstract serializeTerminalBufferFromAvailableState(
    ptyId: string,
    opts?: { scrollbackRows?: number }
  ): Promise<{
    data: string
    frameRestoreAnsi?: string
    cols: number
    rows: number
    cwd?: string | null
    lastTitle?: string
    seq?: number
    source?: 'headless' | 'renderer'
    oscLinks?: TerminalOscLinkRange[]
    alternateScreen?: boolean
    pendingEscapeTailAnsi?: string
    kittyKeyboardFlags?: number
    terminalOwner?: 'shell'
  } | null>
  protected abstract serializeProviderTerminalBuffer(
    ptyId: string,
    opts?: { scrollbackRows?: number },
    wait?: { timeoutMs?: number; retireOnTimeout?: boolean }
  ): Promise<PtyProviderBufferSnapshot | null>
  protected abstract writeTerminalInputChunks(
    ptyId: string,
    text: string,
    options: RuntimeTerminalWriteOptions
  ): Promise<WriteSettlement | undefined>

  private readonly terminalViewerDevices = new TerminalViewerDevices()

  /**
   * A departed device's xterm never blurred; tell PTYs that no remote viewer or local pane still
   * shows. A remaining view whose pane is hidden already blurred, so it does not hold focus.
   */
  protected reportFocusLostForDepartedDevice(deviceClientId: string): void {
    for (const ptyId of this.terminalViewerDevices.takeDeparted(deviceClientId)) {
      if (
        !this.terminalViewSubscribers.mayBeShownRemotely(ptyId) &&
        this.ptyController?.hasRendererSerializer?.(ptyId) !== true
      ) {
        void this.ptyController?.reportFocusLost?.(ptyId)
      }
    }
  }

  protected notifyRemoteTerminalViewPresenceChanged(ptyId: string): void {
    try {
      this.onRemoteTerminalViewPresenceChanged?.(ptyId)
    } catch (err) {
      console.error('[runtime] remote view presence listener threw', { ptyId, err })
    }
  }

  /** Remote views own delivered query replies; paused streams and unelected phones leave them to main. Release is idempotent. */
  registerRemoteTerminalViewSubscriber(
    ptyId: string,
    isOutputPaused?: () => boolean,
    mobileClientId?: string,
    /** Only for views that pause output while their pane is hidden, so "unpaused" means on screen. */
    reportsHiddenPane = false,
    viewerDeviceId?: string
  ): () => void {
    if (viewerDeviceId) {
      this.terminalViewerDevices.record(viewerDeviceId, ptyId)
    }
    const isSilent =
      mobileClientId === undefined
        ? isOutputPaused
        : () =>
            isOutputPaused?.() === true ||
            !this.isMobileTerminalQueryReplyAuthority(ptyId, mobileClientId)
    return this.terminalViewSubscribers.registerRemote(
      ptyId,
      isSilent,
      reportsHiddenPane ? isOutputPaused : undefined
    )
  }

  /** Whether any viewer other than this host's own window shows the PTY, or the user last typed into it, from any client. */
  getTerminalAttention(ptyId: string): RuntimeTerminalAttention {
    return {
      shownRemotely:
        this.getDriver(ptyId).kind === 'mobile' ||
        this.terminalViewSubscribers.isShownRemotely(ptyId),
      lastInputAt: this.terminalRunFacts.readLastDrivingInputAt(ptyId)
    }
  }

  /** Live local daemon sessions with no ingested bytes need attachment; existing headless state or snapshot reconciliation means attach already began. */
  protected isKnownUnattachedLocalDaemonPty(ptyId: string): boolean {
    return this.mainDaemonAttachments.isKnownUnattachedLocal(ptyId)
  }

  /** The local provider lost this PTY's endpoint; main re-attaches it so its output and input resume. */
  notePtyEndpointLoss(ptyId: string): void {
    this.mainDaemonAttachments.noteEndpointLoss(ptyId)
  }

  /** Input waits, bounded, for main's in-flight re-attach after an endpoint loss instead of being refused. */
  protected async waitForPtyEndpointReattach(
    ptyId: string | undefined,
    signal?: AbortSignal
  ): Promise<void> {
    const reattach =
      ptyId === undefined ? undefined : this.mainDaemonAttachments.pendingReattach(ptyId)
    if (ptyId === undefined || !reattach) {
      return
    }
    const generation = this.getPtyLifecycleGeneration(ptyId)
    await this.settleEndpointReattach(ptyId, reattach, signal)
    if (signal?.aborted) {
      // A cancelled send must not be written once the terminal is back.
      throw new Error('request_aborted')
    }
    // Input held for one process must not reach a process that replaced it under the same id.
    if (this.getPtyLifecycleGeneration(ptyId) !== generation) {
      throw new Error('terminal_handle_stale')
    }
  }

  private async settleEndpointReattach(
    ptyId: string,
    first: Promise<boolean>,
    signal?: AbortSignal
  ): Promise<void> {
    const deadline = performance.now() + ENDPOINT_REATTACH_INPUT_WAIT_MS
    // A further loss mid-attach starts another attempt; keep waiting within the same bound.
    let reattach: Promise<boolean> | undefined = first
    while (reattach) {
      const remainingMs = deadline - performance.now()
      if (remainingMs <= 0) {
        return
      }
      const stopWaiting = new AbortController()
      const waitSignal = signal ? AbortSignal.any([signal, stopWaiting.signal]) : stopWaiting.signal
      const settled = await Promise.race([
        reattach.then(() => true),
        delay(remainingMs, false, { signal: waitSignal }).catch(() => false)
      ])
      stopWaiting.abort()
      if (!settled) {
        return
      }
      reattach = this.mainDaemonAttachments.pendingReattach(ptyId)
    }
  }

  /** Mark a raw-output viewer without transferring terminal query authority. */
  registerRawTerminalViewSubscriber(ptyId: string): () => void {
    return this.terminalViewSubscribers.registerRaw(ptyId)
  }

  /** Raw stream presence prevents provider thinning without changing reply ownership. */
  hasRawTerminalViewSubscriber(ptyId: string): boolean {
    return this.terminalViewSubscribers.hasRaw(ptyId)
  }

  /** A pane or remote view uses this PTY; main's own ingestion stream does not count. */
  hasTerminalViewer(ptyId: string): boolean {
    return this.getLeavesForPty(ptyId).length > 0 || this.hasRawTerminalViewSubscriber(ptyId)
  }

  /** Whether a remote view answers this PTY's queries now. */
  hasRemoteTerminalViewSubscriber(ptyId: string): boolean {
    return this.terminalViewSubscribers.hasRemoteAnsweringQueries(ptyId)
  }

  isMobileTerminalQueryReplyAuthority(ptyId: string, clientId: string): boolean {
    // Why: a passive phone watching desktop-sized output must not race the
    // desktop xterm. Mobile becomes reply authority only with the mobile floor.
    if (this.getDriver(ptyId).kind !== 'mobile') {
      return false
    }
    const subscribers = this.mobileSubscribers.get(ptyId)
    if (!subscribers) {
      return false
    }
    // Why: soft-leave resubscribe preserves the original subscription time but
    // reinserts the record. Elect fitted responders from that stable age, not
    // mutable Map order or passive desktop-mode watchers.
    let earliest: { clientId: string; subscribedAt: number } | null = null
    for (const subscriber of subscribers.values()) {
      if (!subscriber.wasResizedToPhone) {
        continue
      }
      if (earliest === null || subscriber.subscribedAt < earliest.subscribedAt) {
        earliest = subscriber
      }
    }
    return earliest?.clientId === clientId
  }

  subscribeToFitOverrideChanges(
    ptyId: string,
    listener: (event: {
      mode: 'mobile-fit' | 'remote-desktop-fit' | 'desktop-fit'
      cols: number
      rows: number
    }) => void
  ): () => void {
    return addListenerToMap(this.fitOverrideListeners, ptyId, listener)
  }

  subscribeToDriverChanges(ptyId: string, listener: (driver: DriverState) => void): () => void {
    return this.terminalDrivers.subscribe(ptyId, listener)
  }

  protected notifyFitOverrideListeners(
    ptyId: string,
    mode: 'mobile-fit' | 'remote-desktop-fit' | 'desktop-fit',
    cols: number,
    rows: number
  ): void {
    const listeners = this.fitOverrideListeners.get(ptyId)
    if (!listeners) {
      return
    }
    notifyRuntimeListeners(listeners, (listener) => listener({ mode, cols, rows }), 'fit-override')
  }

  serializeTerminalBuffer(
    ptyId: string,
    opts: { scrollbackRows?: number } = {}
  ): Promise<RuntimeTerminalBufferSnapshot | null> {
    return this.serializeTerminalBufferFromAvailableState(ptyId, opts)
  }

  async serializeAuthoritativeTerminalBuffer(
    ptyId: string,
    opts: { scrollbackRows?: number } = {}
  ): Promise<RuntimeTerminalBufferSnapshot | null> {
    const providerSnapshot = await this.serializeProviderTerminalBuffer(ptyId, opts, {
      timeoutMs: AUTHORITATIVE_TERMINAL_SNAPSHOT_TIMEOUT_MS,
      retireOnTimeout: true
    })
    if (providerSnapshot) {
      return providerSnapshot
    }
    return this.serializeTerminalBufferFromAvailableState(ptyId, opts)
  }

  /** Raw keystroke pass-through for the pop-out dashboard's terminal preview.
   *  Honors the mobile-presence lock like the main window's pty:write path. */
  async writeTerminalPreviewInput(ptyId: string, data: string): Promise<boolean> {
    if (data.length === 0) {
      return false
    }
    try {
      await assertTerminalInputWithinLimitWithYield(data)
      await this.writeTerminalInputChunks(ptyId, data, {
        inputKind: 'driving',
        inputSource: 'desktop'
      })
      return true
    } catch {
      return false
    }
  }

  hasHeadlessTerminalState(ptyId: string): boolean {
    return this.headlessTerminals.has(ptyId)
  }
}
