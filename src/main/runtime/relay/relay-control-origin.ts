import type WebSocket from 'ws'
import type { E2EEKeypair } from '../e2ee-keypair'
import { CloudRelayTransport } from '../rpc/relay-transport'
import type { MobileSocketWiring } from '../rpc/mobile-socket-wiring'
import { RelayControlClient } from './relay-control-client'
import type {
  RelayConnectionOpenMessage,
  RelayDrainMessage,
  RelayHostHelloAckMessage
} from './relay-control-protocol'
import type { RelayIdentity } from './relay-session-broker-contract'
import type { RelayAssignment } from './relay-http-client'

type RelayControlOriginOptions = {
  assignment: RelayAssignment
  relayJwt: string
  relayHostId: string
  identity: RelayIdentity
  keypair: E2EEKeypair
  appVersion: string
  mobileSocketWiring: MobileSocketWiring
  createControlSocket?: (url: string, relayJwt: string) => WebSocket
  createDataSocket?: (url: string) => WebSocket
  onConnectionOwned: (connectionId: string, origin: RelayControlOrigin) => void
  onConnectionReleased: (connectionId: string, origin: RelayControlOrigin) => void
  onDrain: (origin: RelayControlOrigin, message: RelayDrainMessage) => void
  onClose: (origin: RelayControlOrigin, code: number) => void
}

export class RelayControlOrigin {
  readonly assignment: RelayAssignment
  readonly transport: CloudRelayTransport
  private readonly options: RelayControlOriginOptions
  private readonly controls = new Set<RelayControlClient>()
  private readonly retiredControlTimers = new Map<
    RelayControlClient,
    ReturnType<typeof setTimeout>
  >()
  private activeControl: RelayControlClient | null = null
  private generation = 0
  private controlResumeSecret: string | null = null
  private leaseExpiresAt = 0
  private acceptingConnections = true
  private closed = false
  private readonly detachMobileSocketTransport: () => void

  constructor(options: RelayControlOriginOptions) {
    this.options = options
    this.assignment = options.assignment
    this.transport = new CloudRelayTransport({
      cellUrl: options.assignment.cellUrl,
      relayHostId: options.relayHostId,
      generation: 0,
      createSocket: options.createDataSocket,
      onConnectionClosed: (connectionId) => options.onConnectionReleased(connectionId, this)
    })
    this.detachMobileSocketTransport = options.mobileSocketWiring.attachTransport(
      this.transport,
      (ws) => this.transport.metadataFor(ws)
    )
  }

  get control(): RelayControlClient {
    if (!this.activeControl) {
      throw new Error('relay_control_not_active')
    }
    return this.activeControl
  }

  get availableControl(): RelayControlClient | null {
    return this.activeControl
  }

  get cellUrl(): string {
    return this.assignment.cellUrl
  }

  get assignmentEpoch(): number {
    return this.assignment.assignmentEpoch
  }

  get controlLeaseExpiresAt(): number {
    return this.leaseExpiresAt
  }

  get pendingRequestCount(): number {
    let count = 0
    for (const control of this.controls) {
      count += control.pendingRequestCount
    }
    return count
  }

  async open(): Promise<void> {
    await this.transport.start()
    const { control, ack } = await this.openControl()
    this.activate(control, ack)
  }

  async rebind(relayJwt: string, assignment: RelayAssignment): Promise<void> {
    if (assignment.cellUrl !== this.cellUrl || !this.controlResumeSecret || this.generation <= 0) {
      throw new Error('relay_control_rebind_origin_mismatch')
    }
    const previous = this.activeControl
    const { control, ack } = await this.openControl({
      relayJwt,
      assignmentEpoch: assignment.assignmentEpoch,
      previousGeneration: this.generation,
      controlResumeSecret: this.controlResumeSecret
    })
    this.activate(control, ack)
    this.acceptingConnections = true
    // Why: the resumed control owns the same server generation and splices;
    // the predecessor remains only long enough for any idempotent reply in flight.
    if (previous && previous.pendingRequestCount === 0) {
      this.closeRetiredControl(previous)
    } else if (previous) {
      // Why: basis-bound requests keep their original control through its
      // bounded request deadline; afterward the resumed control is sole owner.
      this.retiredControlTimers.set(
        previous,
        setTimeout(() => this.closeRetiredControl(previous), 10_100)
      )
    }
  }

  markDraining(): void {
    // The relay changes the control's protocol state when it sends drain. This
    // marker exists for the broker's ownership policy, not a second wire event.
    this.acceptingConnections = false
  }

  refreshAuthorization(relayJwt: string): void {
    for (const control of this.controls) {
      try {
        control.refreshAuthorization(relayJwt)
      } catch {
        // A closing drain-only origin cannot block refresh on the active target.
      }
    }
  }

  async close(): Promise<void> {
    if (this.closed) {
      return
    }
    this.closed = true
    for (const timer of this.retiredControlTimers.values()) {
      clearTimeout(timer)
    }
    this.retiredControlTimers.clear()
    for (const control of this.controls) {
      control.closeNow()
    }
    this.controls.clear()
    this.activeControl = null
    try {
      await this.transport.stop()
    } finally {
      // Why: detaching earlier would skip socket-close cleanup in MobileSocketWiring.
      this.detachMobileSocketTransport()
    }
  }

  closeNow(): void {
    void this.close()
  }

  private async openControl(overrides?: {
    relayJwt: string
    assignmentEpoch: number
    previousGeneration: number
    controlResumeSecret: string
  }): Promise<{ control: RelayControlClient; ack: RelayHostHelloAckMessage }> {
    let control!: RelayControlClient
    control = new RelayControlClient({
      cellUrl: this.cellUrl,
      relayJwt: overrides?.relayJwt ?? this.options.relayJwt,
      relayHostId: this.options.relayHostId,
      assignmentEpoch: overrides?.assignmentEpoch ?? this.assignmentEpoch,
      identity: this.options.identity,
      keypair: this.options.keypair,
      appVersion: this.options.appVersion,
      ...(overrides
        ? {
            previousGeneration: overrides.previousGeneration,
            controlResumeSecret: overrides.controlResumeSecret
          }
        : {}),
      onConnectionOpen: (message) => this.openConnection(message),
      onDrain: (message) => this.options.onDrain(this, message),
      onClose: (code) => {
        this.controls.delete(control)
        const timer = this.retiredControlTimers.get(control)
        if (timer) {
          clearTimeout(timer)
          this.retiredControlTimers.delete(control)
        }
        if (this.activeControl === control) {
          this.activeControl = null
          this.options.onClose(this, code)
        }
      },
      createSocket: this.options.createControlSocket
    })
    this.controls.add(control)
    try {
      return { control, ack: await control.connect() }
    } catch (error) {
      this.controls.delete(control)
      control.closeNow()
      throw error
    }
  }

  private closeRetiredControl(control: RelayControlClient): void {
    const timer = this.retiredControlTimers.get(control)
    if (timer) {
      clearTimeout(timer)
      this.retiredControlTimers.delete(control)
    }
    if (this.activeControl !== control && this.controls.delete(control)) {
      control.closeNow()
    }
  }

  private activate(control: RelayControlClient, ack: RelayHostHelloAckMessage): void {
    if (ack.generation <= 0) {
      throw new Error('invalid_relay_generation')
    }
    this.transport.setGeneration(ack.generation)
    this.generation = ack.generation
    this.controlResumeSecret = ack.controlResumeSecret
    this.leaseExpiresAt = ack.leaseExpiresAt
    this.activeControl = control
    for (const connectionId of ack.activeConnIds) {
      this.options.onConnectionOwned(connectionId, this)
    }
  }

  private openConnection(message: RelayConnectionOpenMessage): void {
    if (!this.acceptingConnections) {
      return
    }
    this.options.onConnectionOwned(message.connId, this)
    void this.transport.openConnection(message).catch(() => {
      this.options.onConnectionReleased(message.connId, this)
    })
  }
}
