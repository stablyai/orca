import type { RelayControlOriginOptions } from './relay-control-origin-options'
import { CloudRelayTransport } from '../../rpc/transports/relay-transport'
import { RelayControlClient } from '../control-channel/relay-control-client'
import type {
  RelayConnectionOpenMessage,
  RelayHostHelloAckMessage
} from '../control-channel/relay-control-protocol'
import type { RelayHostCloseReason } from '../../../../shared/remote-runtime/relay/relay-host-close-reason'
import type { RelayAssignment } from '../director/relay-http-client'
import { RelayDataAttachHealth } from './relay-data-attach-health'
import {
  RelayControlFailover,
  type ControlResume,
  type OpenedControl
} from './relay-control-failover'
import { RelayObservedOpens } from './relay-observed-opens'
import { openRacedControl, type ControlRaceLeg } from './relay-control-race'

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
  private readonly observedOpens = new RelayObservedOpens()
  // Latest token, for a failover resume between rotations.
  private relayJwt: string
  private readonly failover = new RelayControlFailover({
    primaryUrl: () => this.cellUrl,
    alternates: () => this.alternateCellUrls,
    isClosed: () => this.closed,
    resumeFor: (stalled) => this.resumeFor(stalled),
    open: (resume, dialUrl) => this.openControl(resume, dialUrl),
    promote: ({ control, ack }, dialUrl, stalled) => {
      this.activate(control, ack, dialUrl)
      this.closeRetiredControl(stalled)
    },
    reportClose: (code) => this.options.onClose(this, code),
    random: () => (this.options.random ?? Math.random)()
  })
  private readonly detachMobileSocketTransport: () => void
  private readonly attachHealth: RelayDataAttachHealth

  constructor(options: RelayControlOriginOptions) {
    this.options = options
    this.assignment = options.assignment
    this.relayJwt = options.relayJwt
    this.attachHealth = new RelayDataAttachHealth(options.assignment.cellUrl, () =>
      options.onDataPathUnhealthy(this)
    )
    this.transport = new CloudRelayTransport({
      cellUrl: options.assignment.cellUrl,
      relayHostId: options.relayHostId,
      generation: 0,
      createSocket: options.createDataSocket,
      onConnectionClosed: (connectionId) => options.onConnectionReleased(connectionId, this),
      onDataDialSettled: (connectionId, openedAfterMs, attached) => {
        // Closing terminates sockets mid-dial; that is not evidence about the path.
        if (!this.closed) {
          this.attachHealth.note(connectionId, openedAfterMs, attached)
        }
      }
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

  // Other origins reaching this same host session, resumed on in order when the primary path stalls.
  get alternateCellUrls(): readonly string[] {
    return this.assignment.alternateCellUrls ?? []
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

  // A fresh connect (first dial after an assign, director recovery onto a new origin) races the
  // primary against the first alternate; a control won on the alternate stays there until rotation.
  async open(): Promise<void> {
    await this.transport.start()
    const { control, ack, dialUrl } = await openRacedControl({
      primaryUrl: this.cellUrl,
      alternateUrl: this.alternateCellUrls[0],
      isClosed: () => this.closed,
      open: (url, leg) => this.openControl(undefined, url, leg)
    })
    this.activate(control, ack, dialUrl)
  }

  // Rotation and director recovery dial the primary: after a failover the host returns to it at most
  // once per rotation, never by flapping.
  async rebind(relayJwt: string, assignment: RelayAssignment): Promise<void> {
    if (this.failover.settled) {
      await this.failover.settled
    }
    if (assignment.cellUrl !== this.cellUrl || !this.controlResumeSecret || this.generation <= 0) {
      throw new Error('relay_control_rebind_origin_mismatch')
    }
    this.relayJwt = relayJwt
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
    this.relayJwt = relayJwt
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

  private async openControl(
    overrides?: ControlResume,
    dialUrl = this.cellUrl,
    raceLeg?: ControlRaceLeg
  ): Promise<OpenedControl> {
    // Only a primary-path control watches for a stall; the alternate is kept until rotation.
    const watchStall = dialUrl === this.cellUrl && this.alternateCellUrls.length > 0
    const control: RelayControlClient = new RelayControlClient({
      cellUrl: dialUrl,
      relayJwt: overrides?.relayJwt ?? this.relayJwt,
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
        clearTimeout(this.retiredControlTimers.get(control))
        this.retiredControlTimers.delete(control)
        if (this.activeControl === control) {
          this.activeControl = null
          if (!this.failover.deferClose(code)) {
            this.options.onClose(this, code)
          }
        }
      },
      createSocket: this.options.createControlSocket,
      ...(watchStall ? { onStall: () => this.failover.start(control) } : {}),
      ...(raceLeg ? { claimChallenge: raceLeg.claim } : {})
    })
    this.controls.add(control)
    raceLeg?.signal.addEventListener('abort', () => control.closeNow(), { once: true })
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

  // A rebind (rotation, director recovery) already opening a control makes a stall not ours to act on.
  private resumeFor(stalled: RelayControlClient): ControlResume | null {
    const ready = this.activeControl === stalled && this.controls.size === 1 && this.generation > 0
    return ready && this.controlResumeSecret
      ? {
          relayJwt: this.relayJwt,
          assignmentEpoch: this.assignmentEpoch,
          previousGeneration: this.generation,
          controlResumeSecret: this.controlResumeSecret
        }
      : null
  }

  private activate(
    control: RelayControlClient,
    ack: RelayHostHelloAckMessage,
    dialUrl = this.cellUrl
  ): void {
    // hello-ack and close can share one parser turn; never promote already-closed control.
    if (!this.controls.has(control) || !control.isLive()) {
      throw new Error('relay_control_closed_before_activation')
    }
    if (ack.generation <= 0) {
      throw new Error('invalid_relay_generation')
    }
    this.transport.setGeneration(ack.generation)
    this.transport.setDataOrigin(dialUrl)
    this.generation = ack.generation
    this.controlResumeSecret = ack.controlResumeSecret
    this.leaseExpiresAt = ack.leaseExpiresAt
    this.activeControl = control
    for (const connectionId of ack.activeConnIds) {
      this.options.onConnectionOwned(connectionId, this)
    }
    this.replayPendingConnections(ack)
  }

  // Rotation/rebind/failover must replay pending attaches because conn-open was emitted only once.
  private replayPendingConnections(ack: RelayHostHelloAckMessage): void {
    const active = new Set(ack.activeConnIds)
    for (const pending of ack.pendingConns) {
      if (active.has(pending.connId) || this.transport.hasConnection(pending.connId)) {
        continue
      }
      const message = this.observedOpens.pendingConnectionOpen(pending)
      if (!message) {
        console.warn('[relay] pending connection not replayable: relay stated no kind/device')
        continue
      }
      this.dialConnection(message)
    }
  }

  private openConnection(message: RelayConnectionOpenMessage): void {
    if (this.closed) {
      return
    }
    this.observedOpens.remember(message)
    this.dialConnection(message)
  }

  private dialConnection(message: RelayConnectionOpenMessage): void {
    this.options.onConnectionOwned(message.connId, this)
    void this.transport.openConnection(message).catch(() => {
      this.options.onConnectionReleased(message.connId, this)
    })
  }
}
