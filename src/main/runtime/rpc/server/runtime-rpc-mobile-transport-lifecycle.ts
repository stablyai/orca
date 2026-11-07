import { AGENT_LAUNCH_RUNTIME_CAPABILITY } from '../../../../shared/agent-launch/contracts/agent-launch-runtime-capability'
import { parseIrohRelayUrl } from '../../../../shared/iroh-relay-preference'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import { placeUnshownLiveTerminalsBestEffort } from '../../terminal/adoption/unshown-live-terminal-placement'
import type { DeviceRegistry } from './pairing/device-registry'
import type { E2EEKeypair } from '../../e2ee-keypair'
import { IrohModuleLoadError } from '../iroh-endpoint-bind'
import { IrohEndpointSecretError } from '../iroh-endpoint-secret'
import { IrohTransport } from '../iroh-transport'
import { MobileSocketWiring } from '../mobile-socket-wiring'
import { UnpairedDeviceAuthThrottle } from '../unpaired-device-auth-throttle'
import { RuntimeRpcWebSocketDispatch } from './runtime-rpc-websocket-dispatch'

export class RuntimeRpcMobileTransportLifecycle extends RuntimeRpcWebSocketDispatch {
  /** Honor the emergency kill switch except when tests explicitly inject endpoint binding. */
  private shouldStartIrohTransport(): boolean {
    // Why: iroh is on by default; ORCA_DISABLE_IROH=1 is the emergency kill switch.
    // An injected test bind always starts (vitest sets the kill switch globally
    // so unfaked servers never open real UDP or touch the public relay).
    return this.irohBindEndpoint !== undefined || process.env.ORCA_DISABLE_IROH !== '1'
  }

  /** Validate the relay and fence stale pairing hints before scheduling an iroh-only rebind. */
  setIrohRelayUrl(value: string | null): Promise<void> {
    const relayUrl = parseIrohRelayUrl(value)
    if (relayUrl !== this.desiredIrohRelayUrl) {
      // Settings listeners are synchronous: fence stale status and pairing before save acknowledges.
      this.desiredIrohRelayUrl = relayUrl
      this.irohRelayGeneration += 1
      this.irohRelayRetry.cancel()
      this.irohRelayRetry.reset()
      void this.pendingIrohTransport?.stop().catch(() => {})
    }
    if (!this.irohRuntimeStarted || this.stopping) {
      return Promise.resolve()
    }
    return this.ensureIrohRelayBinding()
  }

  /** Serialize relay changes until the latest generation is applied or awaiting retry. */
  protected ensureIrohRelayBinding(): Promise<void> {
    if (!this.irohRebindPromise) {
      if (
        this.stopping ||
        this.irohRelayRetry.pending ||
        this.appliedIrohRelayGeneration === this.irohRelayGeneration
      ) {
        return Promise.resolve()
      }
      this.irohRebindPromise = this.rebindIrohTransport().finally(() => {
        this.irohRebindPromise = null
        if (
          !this.stopping &&
          !this.irohRelayRetry.pending &&
          this.appliedIrohRelayGeneration !== this.irohRelayGeneration
        ) {
          return this.ensureIrohRelayBinding()
        }
        return undefined
      })
    }
    return this.irohRebindPromise
  }

  /** Wait for active rebinds, including replacements queued by a concurrent preference change. */
  protected async waitForIrohRelayBinding(): Promise<void> {
    while (this.irohRebindPromise) {
      await this.irohRebindPromise
    }
  }

  /** Replace only iroh, discarding stale binds and retrying transient but not SDK-load failures. */
  private async rebindIrohTransport(): Promise<void> {
    while (!this.stopping && this.appliedIrohRelayGeneration !== this.irohRelayGeneration) {
      const generation = this.irohRelayGeneration
      const relayUrl = this.desiredIrohRelayUrl
      const previous = this.irohTransport
      this.irohTransport = null
      this.detachIrohWiring?.()
      this.detachIrohWiring = null
      if (previous) {
        const index = this.activeTransports.indexOf(previous)
        if (index !== -1) {
          this.activeTransports.splice(index, 1)
        }
        await previous.stop().catch(() => {})
      }
      if (this.stopping || generation !== this.irohRelayGeneration) {
        continue
      }
      if (!this.shouldStartIrohTransport() || !this.deviceRegistry || !this.e2eeKeypair) {
        this.appliedIrohRelayGeneration = generation
        continue
      }
      const transport = new IrohTransport({
        userDataPath: this.userDataPath,
        relayUrl,
        ...(this.irohBindEndpoint ? { bindEndpoint: this.irohBindEndpoint } : {})
      })
      this.pendingIrohTransport = transport
      try {
        await transport.start()
        if (this.stopping || generation !== this.irohRelayGeneration || !transport.endpointId) {
          await transport.stop()
          continue
        }
        const wiring = this.ensureMobileSocketWiring(this.deviceRegistry, this.e2eeKeypair)
        this.detachIrohWiring = wiring.attachTransport(transport, () => ({ transport: 'iroh' }))
        this.irohTransport = transport
        // Iroh is mobile-only, not advertised in CLI bootstrap metadata.
        this.activeTransports.push(transport)
        this.appliedIrohRelayGeneration = generation
        this.irohRelayRetry.reset()
      } catch (error) {
        console.error(
          error instanceof IrohModuleLoadError || error instanceof IrohEndpointSecretError
            ? `[runtime] ${error.message}`
            : '[runtime] Failed to bind the selected Iroh relay'
        )
        await transport.stop().catch(() => {})
        if (!this.stopping && generation === this.irohRelayGeneration) {
          if (error instanceof IrohModuleLoadError) {
            this.appliedIrohRelayGeneration = generation
            continue
          }
          this.irohRelayRetry.schedule(1_000, () => {
            if (!this.stopping && generation === this.irohRelayGeneration) {
              void this.ensureIrohRelayBinding().catch(() => {
                console.error('[runtime] Failed to retry the selected Iroh relay')
              })
            }
          })
          return
        }
      } finally {
        if (this.pendingIrohTransport === transport) {
          this.pendingIrohTransport = null
        }
      }
    }
  }

  /** Reuse shared session wiring so transport replacement preserves relay and revocation state. */
  protected ensureMobileSocketWiring(
    deviceRegistry: DeviceRegistry,
    e2eeKeypair: E2EEKeypair
  ): MobileSocketWiring {
    if (this.mobileSocketWiring) {
      return this.mobileSocketWiring
    }
    // Allow one re-pair notification per session, including across rebinds.
    this.unpairedDeviceAuthThrottle = new UnpairedDeviceAuthThrottle({
      onTrigger: () => this.onUnpairedDeviceAuthFailure?.()
    })
    const mobileSocketWiring = new MobileSocketWiring({
      deviceRegistry,
      e2eeKeypair,
      onText: (socket, plaintext, reply, sendBinary) => {
        void this.trackClientRequest(() =>
          this.handleWebSocketMessage(
            plaintext,
            reply,
            sendBinary,
            undefined,
            socket.ws,
            socket.device.deviceToken ?? null,
            socket
          )
        )
      },
      onBinary: (socket, bytes) => {
        this.lastClientRequestAt = Date.now()
        this.handleWebSocketBinaryMessage(bytes, socket.ws)
      },
      onReady: (socket) => {
        if (socket.transport.transport === 'direct') {
          this.authenticatedSourceRecorder.note(socket.transport.sourceClass)
        }
        this.mobileRelayPairingProvider?.onDemandStateChanged?.()
        if (socket.clientCapabilities.includes(AGENT_LAUNCH_RUNTIME_CAPABILITY)) {
          this.runtime.noteAgentLaunchClientReady?.()
        }
        // Publish every live host terminal as a tab on attach.
        if (ORCA_LAYOUT_OWNER_IS_MAIN) {
          void placeUnshownLiveTerminalsBestEffort(this.runtime)
        }
        // Update capabilities once per socket; only phones send their own later update.
        if (socket.device.scope === 'runtime') {
          this.runtime.sidebarFacts?.noteRuntimeClient(
            socket.connectionId,
            socket.clientCapabilities
          )
        }
      },
      onClose: (socket, hasOtherConnections) => {
        if (!socket) {
          return
        }
        this.abortWebSocketDispatches(socket.ws)
        this.mobileDesktopRelay?.closePhoneConnection(socket.connectionId)
        // Stream cleanup is socket-scoped; disconnect state spans all transports for that device.
        this.runtime.cleanupSubscriptionsForConnection(socket.connectionId)
        // Optional: runtime stand-ins without staged saves must still close cleanly.
        void this.runtime.stagedFileSaves?.abortConnection(socket.connectionId)
        this.binaryMessageRouter.deleteConnection(socket.connectionId)
        this.declaredDesktopClients.forget(socket.connectionId)
        if (!hasOtherConnections) {
          this.runtime.onClientDisconnected(socket.device.clientId)
        }
      },
      // Relay handles authorization upstream; only direct failures prompt local re-pairing.
      onUnpairedDeviceAuthFailure: (metadata) => {
        if (metadata.transport !== 'relay') {
          this.unpairedDeviceAuthThrottle?.recordFailure()
        }
      }
    })
    this.mobileSocketWiring = mobileSocketWiring
    return mobileSocketWiring
  }
}
