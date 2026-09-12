import { RelayOriginRetirement } from './relay-origin-retirement'
import type { RelayOriginPoolOptions } from './relay-origin-pool-options'
import { RelayControlOrigin } from './relay-control-origin'
import type { RelayControlClient } from './relay-control-client'
import type { RelayDrainMessage } from './relay-control-protocol'
import type { RelayHostCloseReason } from '../../../shared/relay-host-close-reason'
import { RelayDrainRetrySchedule } from './relay-drain-retry-schedule'
import { RelayHttpError, requestRelayAssignment, type RelayAssignment } from './relay-http-client'
import { RelayControlRotation } from './relay-control-rotation'

export class RelayOriginPool {
  private activeOrigin: RelayControlOrigin | null = null
  private readonly origins = new Set<RelayControlOrigin>()
  private readonly retirement = new RelayOriginRetirement(
    () => this.activeOrigin,
    (origin) => {
      this.origins.delete(origin)
    }
  )
  private readonly drainingOrigins = this.retirement.draining
  private readonly basisOrigins = this.retirement.basis
  private assignment: RelayAssignment | null = null
  private deferredAssignment: RelayAssignment | null = null
  private relayJwt: string | null = null
  private readonly rotation: RelayControlRotation
  private rotationPromise: Promise<void> | null = null
  private readonly drainRetry: RelayDrainRetrySchedule
  private closed = false

  constructor(private readonly options: RelayOriginPoolOptions) {
    this.drainRetry = new RelayDrainRetrySchedule(options.random)
    this.rotation = new RelayControlRotation({
      ...options,
      current: () => this.activeOrigin,
      available: () => this.isCurrent(),
      token: () => this.relayJwt,
      assignment: () => this.assignment,
      busy: () => Boolean(this.rotationPromise)
    })
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

  hasLiveControl(): boolean {
    return this.activeOrigin?.hasLiveControl() ?? false
  }

  applyAssignmentMetadata(assignment: RelayAssignment): boolean {
    const current = this.assignment
    if (!this.isCurrent() || !current || assignment.assignmentEpoch < current.assignmentEpoch) {
      return false
    }
    if (assignment.assignmentEpoch > current.assignmentEpoch || this.rotationPromise) {
      if (
        !this.deferredAssignment ||
        assignment.assignmentEpoch >= this.deferredAssignment.assignmentEpoch
      ) {
        this.deferredAssignment = assignment
      }
      return true
    }
    if (assignment.cellUrl !== current.cellUrl) {
      return false
    }
    this.assignment = assignment
    this.activeOrigin?.updateAssignment(assignment)
    return true
  }

  async openInitial(assignment: RelayAssignment, relayJwt: string): Promise<void> {
    this.assignment = assignment
    this.relayJwt = relayJwt
    const origin = this.createOrigin(assignment, relayJwt)
    this.origins.add(origin)
    await origin.open()
    this.assertCurrent()
    this.activeOrigin = origin
    this.rotation.schedule()
  }

  refreshAuthorization(relayJwt: string): void {
    this.relayJwt = relayJwt
    for (const origin of this.origins) {
      origin.refreshAuthorization(relayJwt)
    }
  }

  closeNow(hostCloseReason?: RelayHostCloseReason): void {
    if (this.closed) {
      return
    }
    this.closed = true
    this.rotation.cancel()
    this.drainRetry.cancel()
    this.retirement.clear()
    for (const origin of this.origins) {
      origin.closeNow(hostCloseReason)
    }
    this.origins.clear()
    this.activeOrigin = null
  }

  private createOrigin(assignment: RelayAssignment, relayJwt: string): RelayControlOrigin {
    return new RelayControlOrigin({
      ...this.options,
      assignment,
      relayJwt,
      onConnectionOwned: (connectionId, origin) => {
        if (this.isCurrent() && this.origins.has(origin)) {
          this.basisOrigins.set(connectionId, origin)
        }
      },
      onConnectionReleased: (connectionId, origin) => {
        if (this.basisOrigins.get(connectionId) === origin) {
          this.basisOrigins.delete(connectionId)
        }
        this.retirement.maybeClose(origin)
      },
      onDrain: (origin, message) => this.handleDrain(origin, message),
      onPendingChanged: (origin) => this.retirement.maybeClose(origin),
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
    if (!this.isCurrent() || !this.origins.has(origin)) {
      return
    }
    if (!this.retirement.adopt(origin, message)) {
      return
    }
    this.options.onStatus('draining')
    if (!this.rotationPromise && !this.drainRetry.pending) {
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
      const preferredRegion = await this.options.resolvePreferredRegion?.().catch(() => undefined)
      this.assertCurrent()
      // Why: only the configured director can choose a migration target.
      let assignment = await requestRelayAssignment({
        directorUrl: this.options.directorUrl,
        relayToken: this.relayJwt,
        relayHostId: this.options.relayHostId,
        // Recovery always follows an established assignment; the director
        // verifies this and admits through its reconnect fast lane.
        reconnect: true,
        preferredRegion,
        isCurrent: () => this.isCurrent(),
        fetch: this.options.fetch
      })
      this.assertCurrent()
      if (
        this.deferredAssignment &&
        this.deferredAssignment.assignmentEpoch > assignment.assignmentEpoch
      ) {
        assignment = this.deferredAssignment
      }
      this.deferredAssignment = null
      if (assignment.cellUrl === origin.cellUrl) {
            let rebound = false
        try {
          await origin.rebind(this.relayJwt, assignment)
          rebound = true
        } catch {
          // Why: a restarted cell cannot know the prior process's resume secret;
          // after rebind fails, a fresh generation is the only recoverable path.
          await this.activateTarget(
            origin,
            assignment,
            this.relayJwt,
            message.graceMs,
            )
        }
        if (rebound) {
          this.assertCurrent()
          this.activeOrigin = origin
          this.assignment = assignment
          this.drainingOrigins.delete(origin)
        }
      } else {
        await this.activateTarget(
          origin,
          assignment,
          this.relayJwt,
          message.graceMs,
        )
      }
      this.options.onStatus('registered')
      this.drainRetry.reset()
      this.rotation.schedule()
    } catch (error) {
      if (this.isCurrent() && origin === this.activeOrigin) {
        // Why: this retry loop ran silently during the 2026-08 incident while
        // Director 503 throttling stretched recovery to minutes.
        console.warn(
          '[relay] control recovery attempt failed:',
          error instanceof Error ? error.message : String(error)
        )
        const retryAfterMs = error instanceof RelayHttpError ? (error.retryAfterMs ?? 0) : 0
        this.drainRetry.schedule(retryAfterMs, () => this.handleDrain(origin, message))
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
    this.retirement.schedule(origin, graceMs)
    this.retirement.maybeClose(origin)
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
