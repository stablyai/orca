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

type DesktopPushServiceOptions = {
  runtime: OrcaRuntimeService
  runtimeRpc: OrcaRuntimeRpcServer
  gatewayUrl: string
  /** Test seam: lets a suite drive the service without a live gateway. */
  client?: PushGatewayClient
}

export class DesktopPushService {
  private readonly runtime: OrcaRuntimeService
  private readonly runtimeRpc: OrcaRuntimeRpcServer
  private readonly registry: DeviceRegistry
  private readonly outbox: PushUnregisterOutbox
  private readonly client: PushGatewayClient
  private readonly dispatcher: PushDispatcher
  private unsubscribe: (() => void) | null = null
  private flushing = false

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
    this.registry.setPushRegistration(input.deviceId, {
      registrationId: result.registrationId,
      platform: input.platform,
      filter: input.filter,
      registeredAt: Date.now()
    })
    void this.flushUnregisterOutbox()
    return { registered: true, registrationId: result.registrationId }
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

  async flushUnregisterOutbox(): Promise<void> {
    if (this.flushing) {
      return
    }
    this.flushing = true
    try {
      // Safe to iterate while removing: the outbox swaps in a new array per write.
      for (const item of this.outbox.pending()) {
        const result = await this.client.deleteDevice(item.registrationId)
        if (result.deleted || !result.retryable) {
          this.outbox.remove(item.reqId)
        }
      }
    } catch (error) {
      console.warn('[push] Failed to drain the push unregister outbox:', error)
    } finally {
      this.flushing = false
    }
  }
}
