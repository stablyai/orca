import { describe, expect, it, vi } from 'vitest'
import { DesktopRelayService } from './desktop-relay-service'
import type { MobilePairingConnectionMode } from '../../../shared/mobile-pairing-connection-mode'

/**
 * A host LAN flip lands mid-mint.
 *
 * `hasDemand` filters the in-flight operation's OWN transient ref through the live policy
 * (relay-demand-ledger.ts:50-54), so the flip withdraws the demand that operation is holding.
 * The coordinator then publishes `standby`, which clears `offlineReason` to null, and the broker
 * wait returns with no cause — `relay_control_not_active`, the generic code this stack exists to
 * remove. The flip is the cause and `relay_disabled_for_device` is already its word.
 */
type TransientDemandHost = {
  withTransientDemand: (
    kind: string,
    deviceId: string,
    operation: () => Promise<unknown>
  ) => Promise<unknown>
}

function serviceWithMode(mode: { current: MobilePairingConnectionMode }): {
  run: (operation: () => Promise<unknown>) => Promise<unknown>
  release: ReturnType<typeof vi.fn>
} {
  const release = vi.fn()
  const service = Object.create(DesktopRelayService.prototype) as DesktopRelayService
  Object.assign(service, {
    hostMobilePairingConnectionMode: () => mode.current,
    runtimeRpc: {
      getDeviceRegistry: () => ({ getMobilePairingConnectionMode: () => 'automatic' })
    },
    demandLedger: { acquireTransient: () => release },
    refreshDemand: () => {}
  })
  const host = service as unknown as TransientDemandHost
  return {
    run: (operation) => host.withTransientDemand.call(service, 'pairing', 'device-1', operation),
    release
  }
}

describe('DesktopRelayService policy flip during an in-flight grant', () => {
  it('names the LAN flip rather than the generic control-not-active code', async () => {
    const mode = { current: 'automatic' as MobilePairingConnectionMode }
    const { run, release } = serviceWithMode(mode)

    await expect(
      run(async () => {
        mode.current = 'local-only'
        // What requireActiveBroker throws once the flip cleared the offline reason.
        throw new Error('relay_control_not_active')
      })
    ).rejects.toThrow('relay_disabled_for_device')
    expect(release).toHaveBeenCalled()
  })

  it('does not rewrite a failure the policy had nothing to do with', async () => {
    const mode = { current: 'automatic' as MobilePairingConnectionMode }
    const { run } = serviceWithMode(mode)

    await expect(
      run(async () => {
        throw new Error('relay_broker_unavailable')
      })
    ).rejects.toThrow('relay_broker_unavailable')
  })

  it('still refuses at the entry gate when the policy already excludes the device', async () => {
    const mode = { current: 'local-only' as MobilePairingConnectionMode }
    const { run } = serviceWithMode(mode)
    const operation = vi.fn(async () => 'unreachable')

    await expect(run(operation)).rejects.toThrow('relay_disabled_for_device')
    expect(operation).not.toHaveBeenCalled()
  })

  it('leaves a successful grant alone even if the policy flips under it', async () => {
    const mode = { current: 'automatic' as MobilePairingConnectionMode }
    const { run } = serviceWithMode(mode)

    await expect(
      run(async () => {
        mode.current = 'local-only'
        return 'minted'
      })
    ).resolves.toBe('minted')
  })
})
