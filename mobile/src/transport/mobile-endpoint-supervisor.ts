import { runMobileDirectProbe } from './mobile-direct-probe-operation'
import {
  createMobileEndpointHysteresis,
  type MobileEndpointHysteresis
} from './mobile-endpoint-hysteresis'
import { MobileRelayCredentialRecovery } from './mobile-relay-credential-recovery'
import type { MobileEndpointSupervisorDependencies } from './mobile-endpoint-supervisor-dependencies'
import { MobileRelayRecoveryTimer } from './mobile-relay-recovery-timer'
import { migrateMobileRelaySession } from './mobile-relay-session-migration'
import {
  retryMobileRelayWithEndpointRefresh,
  type MobileRelayAttemptResult
} from './mobile-relay-endpoint-retry'
import type { StableLogicalRpcClient } from './stable-logical-rpc-client'
import type { HostProfile } from './types'

export type { MobileEndpointSupervisorDependencies } from './mobile-endpoint-supervisor-dependencies'

const DIRECT_PROBE_INTERVAL_MS = 15_000
type RelayCredential = { token: string; version: number }

export class MobileEndpointSupervisor {
  private stopped = false
  private ready = false
  private foreground = true
  private operationInFlight = false
  private relayRotationPending = false
  private probeTimer: ReturnType<typeof setTimeout> | null = null
  private unsubscribeState: (() => void) | null = null
  private readonly hysteresis: MobileEndpointHysteresis
  private readonly credentialRecovery: MobileRelayCredentialRecovery
  private readonly recoveryTimer: MobileRelayRecoveryTimer
  private readonly leaseTimer: MobileRelayRecoveryTimer

  constructor(
    private readonly logical: StableLogicalRpcClient,
    host: HostProfile,
    private readonly dependencies: MobileEndpointSupervisorDependencies
  ) {
    this.credentialRecovery = new MobileRelayCredentialRecovery(host, dependencies)
    this.recoveryTimer = new MobileRelayRecoveryTimer(
      dependencies.setTimer,
      dependencies.clearTimer
    )
    this.leaseTimer = new MobileRelayRecoveryTimer(dependencies.setTimer, dependencies.clearTimer)
    this.hysteresis = createMobileEndpointHysteresis(dependencies.now())
  }

  async start(): Promise<void> {
    await this.credentialRecovery.load()
    if (this.stopped || !this.credentialRecovery.host.relay) {
      return
    }
    this.ready = true
    this.unsubscribeState = this.logical.onStateChange((state) => {
      if (!this.foreground) {
        return
      }
      if (state === 'connected') {
        if (this.logical.getActivePath() !== 'relay') {
          if (this.credentialRecovery.needsAuthenticatedRepair) {
            void this.reprovisionRelayCredentialIfPossible()
          } else {
            void this.credentialRecovery.rotateIfNeeded(this.logical)
          }
        }
        this.scheduleDirectProbe()
      } else if (state === 'reconnecting' || state === 'disconnected' || state === 'auth-failed') {
        // Why: the direct client may stay reconnecting without another state change after its first failed dial.
        void this.recoverRelay()
      }
    })
    if (!this.credentialRecovery.hasUsableCredential()) {
      this.credentialRecovery.markUnavailable()
      await this.reprovisionRelayCredentialIfPossible()
      return
    }
    const initialState = this.logical.getState()
    if (
      initialState === 'reconnecting' ||
      initialState === 'disconnected' ||
      initialState === 'auth-failed'
    ) {
      // Why: the first direct dial may fail before encrypted relay credentials finish loading.
      await this.recoverRelay()
    } else if (
      this.foreground &&
      initialState === 'connected' &&
      this.logical.getActivePath() !== 'relay'
    ) {
      await this.credentialRecovery.rotateIfNeeded(this.logical)
    } else {
      this.scheduleDirectProbe()
    }
  }

  setForeground(foreground: boolean): void {
    this.foreground = foreground
    if (!this.ready) {
      return
    }
    if (foreground) {
      if (
        this.logical.getState() === 'connected' &&
        this.logical.getActivePath() !== 'relay' &&
        this.credentialRecovery.needsAuthenticatedRepair
      ) {
        void this.reprovisionRelayCredentialIfPossible()
      } else {
        void this.recoverRelay(this.relayRotationPending)
      }
      this.scheduleDirectProbe(0)
    } else {
      if (this.logical.getActivePath() === 'relay') {
        // Why: background phones must not hold billed relay data splices; the
        // stable client keeps subscriptions for authenticated foreground replay.
        this.logical.suspendActiveSession()
      }
      if (this.probeTimer) {
        this.dependencies.clearTimer(this.probeTimer)
        this.probeTimer = null
      }
    }
  }

  stop(): void {
    this.stopped = true
    this.unsubscribeState?.()
    this.unsubscribeState = null
    if (this.probeTimer) {
      this.dependencies.clearTimer(this.probeTimer)
      this.probeTimer = null
    }
    this.recoveryTimer.clear()
    this.leaseTimer.clear()
  }

  private async recoverRelay(forceReplacement = false): Promise<void> {
    if (
      this.stopped ||
      !this.foreground ||
      this.operationInFlight ||
      !this.credentialRecovery.host.relay ||
      (!forceReplacement && this.logical.getState() === 'connected')
    ) {
      return
    }
    this.operationInFlight = true
    let recovered = false
    try {
      const credentials = this.credentialRecovery.usableCredentials()
      if (credentials.length === 0) {
        this.credentialRecovery.markUnavailable()
        return
      }
      for (const credential of credentials) {
        const result = await this.tryRelayCredential(credential)
        if (result.ok) {
          recovered = true
          return
        }
        this.credentialRecovery.recordFailure(credential.version, result.error)
      }
    } finally {
      this.operationInFlight = false
      if (
        recovered &&
        !this.stopped &&
        this.foreground &&
        this.logical.getState() !== 'connected'
      ) {
        void this.recoverRelay(this.relayRotationPending)
      } else if (!recovered && !this.stopped && this.foreground) {
        const directNeedsRepair =
          this.logical.getState() === 'connected' &&
          this.logical.getActivePath() !== 'relay' &&
          this.credentialRecovery.needsAuthenticatedRepair
        if (directNeedsRepair) {
          void this.reprovisionRelayCredentialIfPossible()
        } else if (
          this.credentialRecovery.hasUsableCredential() &&
          (!forceReplacement || this.relayRotationPending)
        ) {
          this.recoveryTimer.scheduleIfIdle(5000, () => {
            void this.recoverRelay(forceReplacement)
          })
        }
      }
    }
  }

  private async tryRelayCredential(credential: RelayCredential): Promise<MobileRelayAttemptResult> {
    const retried = await retryMobileRelayWithEndpointRefresh({
      host: this.credentialRecovery.host,
      resumeToken: credential.token,
      resolveRelay: this.dependencies.resolveRelay,
      saveHost: this.dependencies.saveHost,
      tryRelay: (host) =>
        migrateMobileRelaySession({
          logical: this.logical,
          relay: host.relay,
          credential,
          recovery: this.credentialRecovery,
          hysteresis: this.hysteresis,
          leaseTimer: this.leaseTimer,
          openRelay: this.dependencies.openRelay,
          randomBytes: this.dependencies.randomBytes,
          now: this.dependencies.now,
          isForeground: () => this.foreground,
          clearRelayRotation: () => {
            this.recoveryTimer.clear()
            this.relayRotationPending = false
          },
          requestRelayRotation: () => {
            this.relayRotationPending = true
            void this.recoverRelay(true)
          },
          scheduleDirectProbe: () => this.scheduleDirectProbe()
        })
    })
    this.credentialRecovery.host = retried.host
    return retried.result
  }

  private scheduleDirectProbe(delayMs = DIRECT_PROBE_INTERVAL_MS): void {
    if (
      this.stopped ||
      !this.foreground ||
      this.logical.getActivePath() !== 'relay' ||
      this.probeTimer
    ) {
      return
    }
    this.probeTimer = this.dependencies.setTimer(() => {
      this.probeTimer = null
      void this.probeDirect()
    }, delayMs)
  }

  private async probeDirect(): Promise<void> {
    if (
      this.stopped ||
      !this.foreground ||
      this.operationInFlight ||
      !this.hysteresis.canProbe(this.dependencies.now())
    ) {
      this.scheduleDirectProbe()
      return
    }
    this.operationInFlight = true
    try {
      await runMobileDirectProbe({
        logical: this.logical,
        host: this.credentialRecovery.host,
        openDirect: this.dependencies.openDirect,
        hysteresis: this.hysteresis,
        recovery: this.credentialRecovery,
        recoveryTimer: this.recoveryTimer,
        leaseTimer: this.leaseTimer,
        now: this.dependencies.now,
        isStopped: () => this.stopped,
        isForeground: () => this.foreground,
        clearRelayRotation: () => {
          this.relayRotationPending = false
        },
        retryCredentialRepair: () => void this.reprovisionRelayCredentialIfPossible()
      })
    } finally {
      this.operationInFlight = false
      if (!this.stopped && this.foreground && this.logical.getState() !== 'connected') {
        void this.recoverRelay(this.relayRotationPending)
      } else if (this.relayRotationPending) {
        void this.recoverRelay(true)
      }
      this.scheduleDirectProbe()
    }
  }

  private async reprovisionRelayCredentialIfPossible(): Promise<void> {
    if (this.stopped || !this.foreground || this.operationInFlight) {
      return
    }
    if (this.logical.getState() !== 'connected' || this.logical.getActivePath() === 'relay') {
      if (this.logical.getState() !== 'connected') {
        void this.recoverRelay(this.relayRotationPending)
      }
      return
    }
    this.recoveryTimer.clear()
    this.leaseTimer.clear()
    this.operationInFlight = true
    let outcome: Awaited<ReturnType<MobileRelayCredentialRecovery['reprovision']>> = 'unsupported'
    try {
      outcome = await this.credentialRecovery.reprovision(this.logical)
    } finally {
      this.operationInFlight = false
      if (!this.stopped && this.foreground) {
        if (this.logical.getState() !== 'connected') {
          void this.recoverRelay(this.relayRotationPending)
        } else if (
          this.logical.getActivePath() !== 'relay' &&
          outcome === 'deferred' &&
          this.credentialRecovery.needsAuthenticatedRepair
        ) {
          this.recoveryTimer.scheduleIfIdle(5000, () => {
            void this.reprovisionRelayCredentialIfPossible()
          })
        }
      }
    }
  }
}
