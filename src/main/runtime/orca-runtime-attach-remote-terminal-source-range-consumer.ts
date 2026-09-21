// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithRecordAgentPromptLifecycleState } from './orca-runtime-record-agent-prompt-lifecycle-state'
import type {
  RemoteTerminalSourceRangeReplacementPublication,
  RemoteTerminalSourceRangeReplacementReservation,
  RemoteTerminalSourceRangeStreamIdentity
} from './remote-terminal-source-range-consumer'
import type { TerminalOutputSourceRange } from '../../shared/terminal-output-source-range'
import type { DriverState } from './orca-runtime-core'
import { addListenerToMap } from './orca-runtime-core'
import { notifyRuntimeListeners } from './runtime-async-boundaries'
import type { RuntimeTerminalBufferSnapshot } from './runtime-terminal-state-records'
import { AUTHORITATIVE_TERMINAL_SNAPSHOT_TIMEOUT_MS } from './orca-runtime-postlude'
import { assertTerminalInputWithinLimitWithYield } from './terminal-send-payload'
import { agentSessionPtyWriteGate } from './agent-session-pty-write-gate'

export class OrcaRuntimeWithAttachRemoteTerminalSourceRangeConsumer extends OrcaRuntimeWithRecordAgentPromptLifecycleState {
  attachRemoteTerminalSourceRangeConsumer(
    identity: RemoteTerminalSourceRangeStreamIdentity
  ): boolean {
    return this.terminalStreamConsumers.attachSourceRangeConsumer(identity)
  }

  settleRemoteTerminalSourceRanges(
    identity: RemoteTerminalSourceRangeStreamIdentity,
    ranges: readonly TerminalOutputSourceRange[]
  ): void {
    this.terminalStreamConsumers.settleSourceRanges(identity, ranges)
  }

  reserveRemoteTerminalSourceRangeReplacement(
    identity: RemoteTerminalSourceRangeStreamIdentity,
    requiredSeq: number,
    reason: string
  ): RemoteTerminalSourceRangeReplacementReservation | null {
    return this.terminalStreamConsumers.reserveSourceRangeReplacement(identity, requiredSeq, reason)
  }

  commitRemoteTerminalSourceRangeReplacement(
    reservation: RemoteTerminalSourceRangeReplacementReservation,
    publication: RemoteTerminalSourceRangeReplacementPublication
  ): boolean {
    return this.terminalStreamConsumers.commitSourceRangeReplacement(reservation, publication)
  }

  rollbackRemoteTerminalSourceRangeReplacement(
    reservation: RemoteTerminalSourceRangeReplacementReservation,
    reason: string
  ): boolean {
    return this.terminalStreamConsumers.rollbackSourceRangeReplacement(reservation, reason)
  }

  cancelRemoteTerminalSourceRanges(
    identity: RemoteTerminalSourceRangeStreamIdentity,
    ranges: readonly TerminalOutputSourceRange[],
    reason: string
  ): void {
    this.terminalStreamConsumers.cancelSourceRanges(identity, ranges, reason)
  }

  protected notifyRemoteTerminalViewPresenceChanged(ptyId: string): void {
    try {
      this.onRemoteTerminalViewPresenceChanged?.(ptyId)
    } catch (err) {
      console.error('[runtime] remote view presence listener threw', { ptyId, err })
    }
  }

  /** Registered by terminal-RPC subscribe/multiplex streams: while a remote
   *  view subscriber is attached its xterm answers queries with view
   *  authority and the model responder must stay silent. Returns an
   *  idempotent release. */
  registerRemoteTerminalViewSubscriber(ptyId: string): () => void {
    return this.terminalViewSubscribers.registerRemote(ptyId)
  }

  /** A local daemon session main knows is live but has never ingested a byte
   *  from — i.e. no pane ever attached it, so the daemon is not emitting.
   *  Headless state exists only after the first ingested byte; a snapshot
   *  reconcile in flight implies a spawn-path attach already happened. */
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

  hasRemoteTerminalViewSubscriber(ptyId: string): boolean {
    return this.terminalViewSubscribers.hasRemote(ptyId)
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
    if (data.length === 0 || this.getDriver(ptyId).kind === 'mobile') {
      return false
    }
    try {
      await assertTerminalInputWithinLimitWithYield(data)
      const admitted = agentSessionPtyWriteGate.assertAdmitted(ptyId)
      await this.writeTerminalInputChunks(
        ptyId,
        data,
        {
          // Why: a phone can claim the floor while a paste yields between chunks.
          beforeWrite: () => {
            if (this.getDriver(ptyId).kind === 'mobile') {
              throw new Error('terminal_mobile_driver_active')
            }
          }
        },
        admitted
      )
      return true
    } catch {
      return false
    }
  }

  hasHeadlessTerminalState(ptyId: string): boolean {
    return this.headlessTerminals.has(ptyId)
  }
}
