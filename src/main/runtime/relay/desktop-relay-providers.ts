import type { OrcaCloudAuthConfig } from '../../orca-profiles/profile-cloud-auth-config'
import type { MobileRelayStatusDetail } from '../../../shared/mobile-relay-status'
import type {
  MobileRelayProvider,
  SelfHostedRelaySettings
} from '../../../shared/mobile-relay-provider'
import type { RelayHostCloseReason } from '../../../shared/relay-host-close-reason'
import type {
  MobileRelayPairingProvider,
  MobilePairingConnectionContext
} from '../runtime-rpc/runtime-rpc-pairing-types'
import type { OrcaRuntimeRpcServer } from '../runtime-rpc'
import type { RelayDeviceBinding, RelayRevokeOutboxItem } from './relay-revoke-outbox'
import { DesktopRelayService } from './desktop-relay-service'
import { SelfHostedRelayStore, type SavedSelfHostedRelay } from './self-hosted-relay-store'
import { getSelfHostedRelayConfig, type SelfHostedRelayConfig } from './self-hosted-relay-config'

type RelayService = Pick<
  DesktopRelayService,
  | 'start'
  | 'stop'
  | 'ensureLive'
  | 'fenceAndCloseNow'
  | 'demandStateChanged'
  | 'createPairingRelay'
  | 'onDeviceRevokeQueued'
  | 'getEndpoints'
  | 'provisionRelay'
>

type Options = {
  authConfig?: OrcaCloudAuthConfig
  userDataPath: string
  settingsPath: string
  packaged: boolean
  appVersion: string
  runtimeRpc: OrcaRuntimeRpcServer
  onStatus: (detail: MobileRelayStatusDetail) => void
  createService?: (options: ConstructorParameters<typeof DesktopRelayService>[0]) => RelayService
}

/** Each paired device keeps its Relay; the picker only chooses where a new invite is minted. */
export class DesktopRelayProviders implements MobileRelayPairingProvider {
  private readonly official: RelayService | null
  private selfHosted: RelayService | null = null
  private saved: SavedSelfHostedRelay | null = null
  private readonly store: SelfHostedRelayStore
  private selfHostedEpoch = 0
  private detail: MobileRelayStatusDetail = { status: 'offline' }

  constructor(private readonly options: Options) {
    this.store = new SelfHostedRelayStore(options.settingsPath, options.packaged)
    this.official = options.authConfig
      ? this.createService({
          authConfig: options.authConfig,
          onStatus: (status, cellUrl) => {
            this.detail = { ...this.detail, status, cellUrl }
            this.publish()
          }
        })
      : null
  }

  start(): void {
    this.official?.start()
    try {
      const saved = this.store.read()
      this.installSelfHosted(saved, saved ? this.prepareSelfHosted(saved.config) : null)
    } catch {
      this.detail = {
        ...this.detail,
        selfHosted: {
          configured: false,
          status: 'offline',
          error: 'Could not load the saved Relay key. Unlock the OS keyring or save it again.'
        }
      }
      this.publish()
    }
  }

  getStatus(): MobileRelayStatusDetail {
    return this.detail
  }

  saveSelfHosted(settings: SelfHostedRelaySettings): void {
    const config = getSelfHostedRelayConfig(settings, this.options.packaged)
    const service = this.prepareSelfHosted(config)
    let saved: SavedSelfHostedRelay
    try {
      saved = this.store.save(settings)
    } catch (error) {
      service.stop()
      throw error
    }
    this.installSelfHosted(saved, service)
  }

  removeSelfHosted(): void {
    this.store.remove()
    this.installSelfHosted(null, null)
  }

  ownsBinding(provider: MobileRelayProvider, binding: RelayDeviceBinding): boolean {
    return provider === 'self-hosted'
      ? binding.ownerIdentityKey === this.selfHostedOwnerKey()
      : !binding.ownerIdentityKey.startsWith('self-hosted\0')
  }

  createPairingRelay: MobileRelayPairingProvider['createPairingRelay'] = (
    deviceId,
    provider = 'official'
  ) => {
    const service = provider === 'self-hosted' ? this.selfHosted : this.official
    if (!service) {
      throw new Error('relay_provider_unavailable')
    }
    return service.createPairingRelay(deviceId)
  }

  getEndpoints: MobileRelayPairingProvider['getEndpoints'] = async (context, params) => {
    const service = this.serviceForDevice(context)
    return service ? await service.getEndpoints(context, params) : { v: 1, relay: null }
  }

  provisionRelay: MobileRelayPairingProvider['provisionRelay'] = async (context, params) => {
    const service = this.serviceForDevice(context)
    if (!service) {
      throw new Error('relay_provider_unavailable')
    }
    return await service.provisionRelay(context, params)
  }

  onDeviceRevokeQueued(item: RelayRevokeOutboxItem): void {
    this.official?.onDeviceRevokeQueued(item)
    this.selfHosted?.onDeviceRevokeQueued(item)
  }

  onDemandStateChanged(): void {
    this.demandStateChanged()
  }

  demandStateChanged(): void {
    this.official?.demandStateChanged()
    this.selfHosted?.demandStateChanged()
  }

  ensureLive(): void {
    this.official?.ensureLive()
    this.selfHosted?.ensureLive()
  }

  fenceAndCloseNow(reason?: RelayHostCloseReason): void {
    this.official?.fenceAndCloseNow(reason)
    // Cloud sign-out cannot revoke authorization on an independently configured server.
    if (reason !== 'signed-out') {
      this.selfHosted?.fenceAndCloseNow(reason)
    }
  }

  stop(): void {
    this.official?.stop()
    this.selfHosted?.stop()
  }

  private serviceForDevice(context: MobilePairingConnectionContext): RelayService | null {
    const registry = this.options.runtimeRpc.getDeviceRegistry()
    const device = registry?.getDevice(context.deviceId)
    if (device?.scope !== 'mobile') {
      throw new Error('mobile_device_not_found')
    }
    if (registry?.getMobilePairingConnectionMode(context.deviceId) === 'local-only') {
      return null
    }
    const provider = registry?.getMobileRelayProvider(context.deviceId) ?? 'official'
    if (
      context.transport.transport === 'relay' &&
      (context.transport.relayProvider ?? 'official') !== provider
    ) {
      throw new Error('stale_relay_connection')
    }
    // A LAN connection must not silently enroll an old pairing on a replacement server.
    if (device.relayBinding && !this.ownsBinding(provider, device.relayBinding)) {
      return null
    }
    return provider === 'self-hosted' ? this.selfHosted : this.official
  }

  private selfHostedOwnerKey(): string | null {
    return this.saved ? `self-hosted\0${this.saved.config.relayDirectorUrl}\0` : null
  }

  private installSelfHosted(
    saved: SavedSelfHostedRelay | null,
    service: RelayService | null
  ): void {
    ++this.selfHostedEpoch
    this.options.runtimeRpc.invalidateMobilePairingOffers('self-hosted')
    this.selfHosted?.stop()
    this.selfHosted = service
    this.saved = saved
    this.detail = {
      ...this.detail,
      selfHosted: {
        configured: saved !== null,
        status: 'offline',
        ...(saved
          ? { url: saved.config.relayDirectorUrl, configurationId: saved.configurationId }
          : {})
      }
    }
    this.selfHosted?.start()
    this.publish()
  }

  private prepareSelfHosted(config: SelfHostedRelayConfig): RelayService {
    const epoch = this.selfHostedEpoch + 1
    return this.createService({
      selfHosted: config,
      onStatus: (status, cellUrl) => {
        const saved = this.saved
        if (epoch !== this.selfHostedEpoch || !saved) {
          return
        }
        this.detail = {
          ...this.detail,
          selfHosted: {
            configured: true,
            status,
            cellUrl,
            url: saved.config.relayDirectorUrl,
            configurationId: saved.configurationId
          }
        }
        this.publish()
      }
    })
  }

  private createService(
    auth: Pick<
      ConstructorParameters<typeof DesktopRelayService>[0],
      'authConfig' | 'selfHosted' | 'onStatus'
    >
  ): RelayService {
    const create = this.options.createService ?? ((options) => new DesktopRelayService(options))
    return create({
      ...auth,
      userDataPath: this.options.userDataPath,
      appVersion: this.options.appVersion,
      runtimeRpc: this.options.runtimeRpc
    })
  }

  private publish(): void {
    this.options.onStatus(this.detail)
  }
}
