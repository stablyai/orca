import type { RelayControlOriginOptions } from './relay-control-origin-options'
import { CloudRelayTransport } from '../rpc/relay-transport'
import { RelayControlClient } from './relay-control-client'
import { RELAY_HOST_ATTACH_DEADLINE_MS } from './relay-control-protocol'
import type {
  RelayConnectionOpenMessage,
  RelayHostHelloAckMessage,
  RelayPendingConnection
} from './relay-control-protocol'
import type { RelayHostCloseReason } from '../../../shared/relay-host-close-reason'
import type { RelayAssignment } from './relay-http-client'

const OBSERVED_OPEN_LIMIT = 16

export class RelayControlOrigin {
  assignment: RelayAssignment
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
  private closed = false
  // Retain conn-open metadata for the attach window so older ack frames need not restate kind/device.
  private readonly observedOpens = new Map<
    string,
    { message: RelayConnectionOpenMessage; seenAt: number }
  >()
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

  hasLiveControl(): boolean {
    return this.activeControl?.isLive() ?? false
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

  get controlGeneration(): number {
    return this.generation
  }

  updateAssignment(assignment: RelayAssignment): void {
    if (assignment.cellUrl !== this.cellUrl || assignment.assignmentEpoch < this.assignmentEpoch) {
      throw new Error('relay_assignment_origin_mismatch')
    }
    this.assignment = assignment
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
    this.updateAssignment(assignment)
    // Resumed control keeps generation/splices; retain predecessor only for pending idempotent replies.
    if (previous && previous.pendingRequestCount === 0) {
      this.closeRetiredControl(previous)
    } else if (previous) {
      // Basis-bound requests retain their old control only until their request deadline.
      this.retiredControlTimers.set(
        previous,
        setTimeout(() => this.closeRetiredControl(previous), 10_100)
      )
    }
  }

  refreshAuthorization(relayJwt: string): void {
    for (const control of this.controls) {
      try {
        control.refreshAuthorization(relayJwt)
      } catch {}
    }
  }

  async close(hostCloseReason?: RelayHostCloseReason): Promise<void> {
    if (this.closed) {
      return
    }
    this.closed = true
    for (const timer of this.retiredControlTimers.values()) {
      clearTimeout(timer)
    }
    this.retiredControlTimers.clear()
    for (const control of this.controls) {
      control.closeNow(hostCloseReason)
    }
    this.controls.clear()
    this.activeControl = null
    this.observedOpens.clear()
    try {
      await this.transport.stop()
    } finally {
      this.detachMobileSocketTransport()
    }
  }

  closeNow(hostCloseReason?: RelayHostCloseReason): void {
    void this.close(hostCloseReason)
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
      onPendingChanged: () => this.options.onPendingChanged?.(this),
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
    // hello-ack and close can share one parser turn; never promote already-closed control.
    if (!this.controls.has(control) || !control.isLive()) {
      throw new Error('relay_control_closed_before_activation')
    }
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
    this.replayPendingConnections(ack)
  }

  // Rotation/rebind must replay pending attaches because conn-open was emitted only once.
  private replayPendingConnections(ack: RelayHostHelloAckMessage): void {
    const active = new Set(ack.activeConnIds)
    for (const pending of ack.pendingConns) {
      if (active.has(pending.connId) || this.transport.hasConnection(pending.connId)) {
        continue
      }
      const message = this.pendingConnectionOpen(pending)
      if (!message) {
        console.warn('[relay] pending connection not replayable: relay stated no kind/device')
        continue
      }
      this.dialConnection(message)
    }
  }

  private pendingConnectionOpen(
    pending: RelayPendingConnection
  ): RelayConnectionOpenMessage | null {
    // Pairing kind/E2EE device must come from relay ack or previously observed conn-open, never guesses.
    const observed = this.observedOpens.get(pending.connId)?.message
    const kind = pending.kind ?? observed?.kind
    const relayDeviceId = pending.relayDeviceId ?? observed?.relayDeviceId
    if (!kind || !relayDeviceId) {
      return null
    }
    return {
      type: 'conn-open',
      connId: pending.connId,
      connTicket: pending.connTicket,
      kind,
      relayDeviceId,
      // Attach began before this control; remaining budget cannot exceed the contract deadline.
      attachDeadlineMs: RELAY_HOST_ATTACH_DEADLINE_MS
    }
  }

  private openConnection(message: RelayConnectionOpenMessage): void {
    if (this.closed) {
      return
    }
    this.rememberOpen(message)
    this.dialConnection(message)
  }

  private dialConnection(message: RelayConnectionOpenMessage): void {
    this.options.onConnectionOwned(message.connId, this)
    void this.transport.openConnection(message).catch(() => {
      this.options.onConnectionReleased(message.connId, this)
    })
  }

  private rememberOpen(message: RelayConnectionOpenMessage): void {
    const now = Date.now()
    for (const [connId, entry] of this.observedOpens) {
      if (now - entry.seenAt > RELAY_HOST_ATTACH_DEADLINE_MS) {
        this.observedOpens.delete(connId)
      }
    }
    // Session cap is 8; bound retained opens even when the clock stalls.
    while (this.observedOpens.size >= OBSERVED_OPEN_LIMIT) {
      const oldest = this.observedOpens.keys().next()
      if (oldest.done) {
        break
      }
      this.observedOpens.delete(oldest.value)
    }
    this.observedOpens.set(message.connId, { message, seenAt: now })
  }
}
