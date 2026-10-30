import { OrcaRuntimeWithRecordAgentPromptLifecycleState } from '../output/terminal-output-generation'
import type { TerminalOscLinkRange } from '../../../../shared/terminal-osc-link-ranges'
import type { PtyProviderBufferSnapshot } from '../../../providers/pty-provider-contract'
import type { RuntimeTerminalWriteOptions } from '../../runtime-terminal-writer'
import type { WriteSettlement } from '../../../../shared/pty-write-settlement'
import type { DriverState } from '../../orca-runtime-core'
import { addListenerToMap } from '../../orca-runtime-core'
import { notifyRuntimeListeners } from '../../runtime-async-boundaries'
import type { RuntimeTerminalBufferSnapshot } from '../../runtime-terminal-state-records'
import { AUTHORITATIVE_TERMINAL_SNAPSHOT_TIMEOUT_MS } from '../../orca-runtime-postlude'
import { assertTerminalInputWithinLimitWithYield } from '../../terminal-send-payload'

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
    mobileClientId?: string
  ): () => void {
    const isSilent =
      mobileClientId === undefined
        ? isOutputPaused
        : () =>
            isOutputPaused?.() === true ||
            !this.isMobileTerminalQueryReplyAuthority(ptyId, mobileClientId)
    return this.terminalViewSubscribers.registerRemote(ptyId, isSilent)
  }

  /** Live local daemon sessions with no ingested bytes need attachment; existing headless state or snapshot reconciliation means attach already began. */
  protected isKnownUnattachedLocalDaemonPty(ptyId: string): boolean {
    return this.terminalViewSubscribers.isKnownUnattachedLocal(ptyId)
  }

  protected reconcileSubscriberDrivenProviderAttach(ptyId: string): void {
    this.terminalViewSubscribers.reconcileProviderAttach(ptyId)
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
