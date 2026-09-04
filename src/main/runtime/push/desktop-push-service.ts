// Why: owns the desktop half of background push — the gateway session, the
// registration each paired phone asked for, and the durable delete queue. Built
// alongside DesktopRelayService but deliberately not gated on cloud sign-in: the
// gateway authenticates with the host keypair, so accountless hosts push too.
import type {
  MobilePushRegisterInput,
  MobilePushRegisterResult
} from '../../../shared/mobile-push-contract'
import type { DeviceRegistry } from '../device-registry'
import type { OrcaRuntimeService } from '../orca-runtime'
import type { OrcaRuntimeRpcServer } from '../runtime-rpc'
import { PushDispatcher } from './push-dispatcher'
import { PushGatewayClient } from './push-gateway-client'
import type { PushUnregisterOutbox } from './push-unregister-outbox'

const OUTBOX_RETRY_BASE_MS = 30_000
const OUTBOX_RETRY_MAX_MS = 10 * 60_000

type RegisterStorageFailure = 'not_mobile' | 'registration_storage_failed'

type DesktopPushServiceOptions = {
  runtime: OrcaRuntimeService
  runtimeRpc: OrcaRuntimeRpcServer
  gatewayUrl: string
  /** Test seam: lets a suite drive the service without a live gateway. */
  client?: PushGatewayClient
  /** Test seam: lets a suite drive the outbox backoff without real timers. */
  scheduleRetry?: (run: () => void, delayMs: number) => void
}

export class DesktopPushService {
  private readonly runtime: OrcaRuntimeService
  private readonly runtimeRpc: OrcaRuntimeRpcServer
  private readonly registry: DeviceRegistry
  private readonly outbox: PushUnregisterOutbox
  private readonly client: PushGatewayClient
  private readonly dispatcher: PushDispatcher
  private readonly scheduleRetry: (run: () => void, delayMs: number) => void
  private unsubscribe: (() => void) | null = null
  private flushLoop: Promise<void> | null = null
  private flushRequested = false
  private retryArmed = false
  private retryDelayMs = OUTBOX_RETRY_BASE_MS
  private stopped = false

  private constructor(
    options: DesktopPushServiceOptions,
    registry: DeviceRegistry,
    client: PushGatewayClient
  ) {
    this.runtime = options.runtime
    this.runtimeRpc = options.runtimeRpc
    this.registry = registry
    this.client = client
    this.outbox = options.runtimeRpc.getPushUnregisterOutbox()
    this.dispatcher = new PushDispatcher({ client, registry })
    this.scheduleRetry =
      options.scheduleRetry ??
      ((run, delayMs) => {
        // Why: a queued gateway delete must never hold the app open at quit.
        setTimeout(run, delayMs).unref?.()
      })
  }

  /** Returns null when the mobile runtime never came up, so there is nothing to push for. */
  static create(options: DesktopPushServiceOptions): DesktopPushService | null {
    const keypair = options.runtimeRpc.getE2EEKeypair()
    const registry = options.runtimeRpc.getDeviceRegistry()
    if (!keypair || !registry) {
      return null
    }
    const client =
      options.client ?? new PushGatewayClient({ gatewayUrl: options.gatewayUrl, keypair })
    return new DesktopPushService(options, registry, client)
  }

  start(): void {
    this.stopped = false
    this.runtime.setMobilePushRegistrar(this)
    this.unsubscribe = this.runtime.onNotificationDispatched((event) => {
      this.dispatcher.enqueue(event)
    })
    // Unpairing queues a delete without going through this service; drain on that too.
    this.runtimeRpc.setOnPushUnregisterQueued(() => {
      void this.flushUnregisterOutbox()
    })
    // Deletes queued while the gateway was unreachable — including across restarts.
    void this.flushUnregisterOutbox()
  }

  stop(): void {
    this.stopped = true
    this.unsubscribe?.()
    this.unsubscribe = null
    this.runtimeRpc.setOnPushUnregisterQueued(null)
    this.runtime.setMobilePushRegistrar(null)
  }

  async register(input: MobilePushRegisterInput): Promise<MobilePushRegisterResult> {
    if (this.registry.getDevice(input.deviceId)?.scope !== 'mobile') {
      return { registered: false, reason: 'not_mobile' }
    }
    const result = await this.client.registerDevice(input)
    if (!result.ok) {
      return {
        registered: false,
        reason: result.reason === 'unreachable' ? 'gateway_unreachable' : 'gateway_rejected'
      }
    }
    const failure = this.storeRegistration(input, result.registrationId)
    if (failure) {
      // Why: the gateway now holds a token this host will never push to. Queue its
      // delete instead of leaking it until the phone happens to register again.
      this.outbox.enqueue({ registrationId: result.registrationId, deviceId: input.deviceId })
    }
    void this.flushUnregisterOutbox()
    return failure
      ? { registered: false, reason: failure }
      : { registered: true, registrationId: result.registrationId }
  }

  async unregister(deviceId: string): Promise<{ unregistered: boolean }> {
    const registrationId = this.registry.getDevice(deviceId)?.pushRegistration?.registrationId
    if (!registrationId) {
      return { unregistered: false }
    }
    // Why: drop the local registration first. The phone asked to stop being pushed
    // to, and that must hold even if the gateway delete has to wait in the outbox.
    this.registry.setPushRegistration(deviceId, null)
    this.outbox.enqueue({ registrationId, deviceId })
    void this.flushUnregisterOutbox()
    return { unregistered: true }
  }

  /** Joining an in-flight drain still waits for the item this call queued. */
  async flushUnregisterOutbox(): Promise<void> {
    this.flushRequested = true
    this.flushLoop ??= this.runFlushLoop().finally(() => {
      this.flushLoop = null
    })
    await this.flushLoop
  }

  private async runFlushLoop(): Promise<void> {
    while (this.flushRequested && !this.stopped) {
      // Cleared before the pass, so a delete queued mid-drain earns another one.
      this.flushRequested = false
      if (await this.drainPending()) {
        this.scheduleFlushRetry()
      } else {
        this.retryDelayMs = OUTBOX_RETRY_BASE_MS
      }
    }
  }

  /** Returns the refusal reason when a gateway-accepted registration cannot be stored. */
  private storeRegistration(
    input: MobilePushRegisterInput,
    registrationId: string
  ): RegisterStorageFailure | null {
    try {
      const stored = this.registry.setPushRegistration(input.deviceId, {
        registrationId,
        platform: input.platform,
        filter: input.filter,
        registeredAt: Date.now()
      })
      // False means the device was removed or left mobile scope while the gateway
      // call was in flight.
      return stored ? null : 'not_mobile'
    } catch (error) {
      console.warn('[push] Failed to persist a push registration:', error)
      return 'registration_storage_failed'
    }
  }

  /** Returns true when the pass left behind an item the gateway may still accept. */
  private async drainPending(): Promise<boolean> {
    const attempted = new Set<string>()
    let retryable = false
    for (;;) {
      // Re-read per item: a snapshot taken at loop entry misses anything queued
      // while an await was in flight, and the outbox swaps arrays on every write.
      const item = this.outbox.pending().find((candidate) => !attempted.has(candidate.reqId))
      if (!item) {
        return retryable
      }
      attempted.add(item.reqId)
      try {
        const result = await this.client.deleteDevice(item.registrationId)
        if (result.deleted || !result.retryable) {
          this.outbox.remove(item.reqId)
        } else {
          retryable = true
        }
      } catch (error) {
        // One bad delete must not strand the rest of the queue.
        console.warn('[push] Failed to drain the push unregister outbox:', error)
        retryable = true
      }
    }
  }

  private scheduleFlushRetry(): void {
    if (this.retryArmed || this.stopped) {
      return
    }
    this.retryArmed = true
    const delayMs = this.retryDelayMs
    this.retryDelayMs = Math.min(delayMs * 2, OUTBOX_RETRY_MAX_MS)
    this.scheduleRetry(() => {
      this.retryArmed = false
      void this.flushUnregisterOutbox()
    }, delayMs)
  }
}
