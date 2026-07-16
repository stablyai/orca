import type WebSocket from 'ws'
import type { E2EEKeypair } from '../e2ee-keypair'
import type { MobileSocketWiring } from '../rpc/mobile-socket-wiring'
import { RelayControlOrigin } from './relay-control-origin'
import type { RelayControlClient } from './relay-control-client'
import type { RelayDrainMessage } from './relay-control-protocol'
import { requestRelayAssignment, type RelayAssignment } from './relay-http-client'
import type { RelayBrokerStatus, RelayIdentity } from './relay-session-broker-contract'

type RelayOriginPoolOptions = {
  directorUrl: string
  relayHostId: string
  identity: RelayIdentity
  keypair: E2EEKeypair
  appVersion: string
  mobileSocketWiring: MobileSocketWiring
  isCurrent: () => boolean
  onStatus: (status: RelayBrokerStatus) => void
  fetch?: typeof globalThis.fetch
  createControlSocket?: (url: string, relayJwt: string) => WebSocket
  createDataSocket?: (url: string) => WebSocket
  random?: () => number
  now?: () => number
}

export class RelayOriginPool {
  private readonly options: RelayOriginPoolOptions
  private activeOrigin: RelayControlOrigin | null = null
  private readonly origins = new Set<RelayControlOrigin>()
  private readonly drainingOrigins = new Set<RelayControlOrigin>()
  private readonly basisOrigins = new Map<string, RelayControlOrigin>()
  private readonly drainTimers = new Map<RelayControlOrigin, ReturnType<typeof setTimeout>>()
  private assignment: RelayAssignment | null = null
  private relayJwt: string | null = null
  private rotationTimer: ReturnType<typeof setTimeout> | null = null
  private rotationPromise: Promise<void> | null = null
  private closed = false

  constructor(options: RelayOriginPoolOptions) {
    this.options = options
  }

  get activeAssignment(): RelayAssignment | null {
    return this.assignment
  }

  get activeControl(): RelayControlClient | null {
    return this.activeOrigin?.availableControl ?? null
  }

  controlForBasis(basisConnId: string): RelayControlClient | null {
    return this.basisOrigins.get(basisConnId)?.availableControl ?? null
  }

  async openInitial(assignment: RelayAssignment, relayJwt: string): Promise<void> {
    this.assignment = assignment
    this.relayJwt = relayJwt
    const origin = this.createOrigin(assignment, relayJwt)
    this.origins.add(origin)
    await origin.open()
    this.assertCurrent()
    this.activeOrigin = origin
    this.scheduleControlRotation()
  }

  refreshAuthorization(relayJwt: string): void {
    this.relayJwt = relayJwt
    for (const origin of this.origins) {
      origin.refreshAuthorization(relayJwt)
    }
  }

  closeNow(): void {
    if (this.closed) {
      return
    }
    this.closed = true
    if (this.rotationTimer) {
      clearTimeout(this.rotationTimer)
      this.rotationTimer = null
    }
    for (const timer of this.drainTimers.values()) {
      clearTimeout(timer)
    }
    this.drainTimers.clear()
    for (const origin of this.origins) {
      origin.closeNow()
    }
    this.origins.clear()
    this.drainingOrigins.clear()
    this.basisOrigins.clear()
    this.activeOrigin = null
  }

  private createOrigin(assignment: RelayAssignment, relayJwt: string): RelayControlOrigin {
    return new RelayControlOrigin({
      assignment,
      relayJwt,
      relayHostId: this.options.relayHostId,
      identity: this.options.identity,
      keypair: this.options.keypair,
      appVersion: this.options.appVersion,
      mobileSocketWiring: this.options.mobileSocketWiring,
      createControlSocket: this.options.createControlSocket,
      createDataSocket: this.options.createDataSocket,
      onConnectionOwned: (connectionId, origin) => {
        if (this.isCurrent() && this.origins.has(origin)) {
          this.basisOrigins.set(connectionId, origin)
        }
      },
      onConnectionReleased: (connectionId, origin) => {
        if (this.basisOrigins.get(connectionId) === origin) {
          this.basisOrigins.delete(connectionId)
        }
        this.maybeCloseDrainedOrigin(origin)
      },
      onDrain: (origin, message) => this.handleDrain(origin, message),
      onClose: (origin) => {
        if (origin === this.activeOrigin && this.isCurrent()) {
          this.options.onStatus('offline')
          this.handleDrain(origin, {
            type: 'drain',
            graceMs: 0,
            recovery: 'resolve-director'
          })
        }
      }
    })
  }

  private handleDrain(origin: RelayControlOrigin, message: RelayDrainMessage): void {
    if (!this.isCurrent() || origin !== this.activeOrigin) {
      return
    }
    origin.markDraining()
    this.drainingOrigins.add(origin)
    this.options.onStatus('draining')
    if (!this.rotationPromise) {
      this.rotationPromise = this.resolveDrainTarget(origin, message).finally(() => {
        this.rotationPromise = null
      })
    }
  }

  private async resolveDrainTarget(
    origin: RelayControlOrigin,
    message: RelayDrainMessage
  ): Promise<void> {
    try {
      if (!this.relayJwt) {
        throw new Error('relay_authorization_unavailable')
      }
      // Why: only the configured director can choose a migration target.
      const assignment = await requestRelayAssignment({
        directorUrl: this.options.directorUrl,
        relayToken: this.relayJwt,
        relayHostId: this.options.relayHostId,
        fetch: this.options.fetch
      })
      this.assertCurrent()
      if (assignment.cellUrl === origin.cellUrl) {
        let rebound = false
        try {
          await origin.rebind(this.relayJwt, assignment)
          rebound = true
        } catch {
          // Why: a restarted cell cannot know the prior process's resume secret;
          // after rebind fails, a fresh generation is the only recoverable path.
          await this.activateTarget(origin, assignment, this.relayJwt, message.graceMs)
        }
        if (rebound) {
          this.assertCurrent()
          this.activeOrigin = origin
          this.assignment = assignment
          this.drainingOrigins.delete(origin)
        }
      } else {
        await this.activateTarget(origin, assignment, this.relayJwt, message.graceMs)
      }
      this.options.onStatus('registered')
      this.scheduleControlRotation()
    } catch {
      if (this.isCurrent()) {
        const random = this.options.random ?? Math.random
        setTimeout(() => this.handleDrain(origin, message), 250 + Math.floor(random() * 751))
      }
    }
  }

  private async activateTarget(
    origin: RelayControlOrigin,
    assignment: RelayAssignment,
    relayJwt: string,
    graceMs: number
  ): Promise<void> {
    const target = this.createOrigin(assignment, relayJwt)
    this.origins.add(target)
    try {
      await target.open()
      this.assertCurrent()
    } catch (error) {
      this.origins.delete(target)
      target.closeNow()
      throw error
    }
    this.activeOrigin = target
    this.assignment = assignment
    this.scheduleDrainDeadline(origin, graceMs)
    this.maybeCloseDrainedOrigin(origin)
  }

  private scheduleControlRotation(): void {
    if (this.rotationTimer) {
      clearTimeout(this.rotationTimer)
    }
    const origin = this.activeOrigin
    if (!origin || this.closed) {
      this.rotationTimer = null
      return
    }
    const now = (this.options.now ?? Date.now)()
    const random = this.options.random ?? Math.random
    const earlyMs = 60_000 + Math.floor(random() * 60_001)
    const delay = Math.max(0, origin.controlLeaseExpiresAt - earlyMs - now)
    this.rotationTimer = setTimeout(() => void this.rebindActiveControl(origin), delay)
  }

  private async rebindActiveControl(origin: RelayControlOrigin): Promise<void> {
    this.rotationTimer = null
    if (!this.isCurrent() || origin !== this.activeOrigin || this.rotationPromise) {
      return
    }
    if (!this.relayJwt || !this.assignment) {
      return
    }
    try {
      await origin.rebind(this.relayJwt, this.assignment)
      this.assertCurrent()
      this.scheduleControlRotation()
    } catch {
      if (this.isCurrent() && origin === this.activeOrigin) {
        const random = this.options.random ?? Math.random
        this.rotationTimer = setTimeout(
          () => void this.rebindActiveControl(origin),
          5_000 + Math.floor(random() * 10_001)
        )
      }
    }
  }

  private scheduleDrainDeadline(origin: RelayControlOrigin, graceMs: number): void {
    const existing = this.drainTimers.get(origin)
    if (existing) {
      clearTimeout(existing)
    }
    this.drainTimers.set(
      origin,
      setTimeout(() => this.closeOrigin(origin), graceMs)
    )
  }

  private maybeCloseDrainedOrigin(origin: RelayControlOrigin): void {
    if (
      !this.drainingOrigins.has(origin) ||
      origin.pendingRequestCount > 0 ||
      [...this.basisOrigins.values()].includes(origin)
    ) {
      return
    }
    this.closeOrigin(origin)
  }

  private closeOrigin(origin: RelayControlOrigin): void {
    if (origin === this.activeOrigin) {
      return
    }
    const timer = this.drainTimers.get(origin)
    if (timer) {
      clearTimeout(timer)
      this.drainTimers.delete(origin)
    }
    for (const [connectionId, owner] of this.basisOrigins) {
      if (owner === origin) {
        this.basisOrigins.delete(connectionId)
      }
    }
    this.drainingOrigins.delete(origin)
    this.origins.delete(origin)
    origin.closeNow()
  }

  private assertCurrent(): void {
    if (!this.isCurrent()) {
      throw new Error('stale_relay_origin_pool')
    }
  }

  private isCurrent(): boolean {
    return !this.closed && this.options.isCurrent()
  }
}
