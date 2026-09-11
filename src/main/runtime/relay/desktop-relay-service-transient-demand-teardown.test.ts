import { describe, expect, it, vi } from 'vitest'
import { DesktopRelayService } from './desktop-relay-service'
import type { MobilePairingConnectionMode } from '../../../shared/mobile-pairing-connection-mode'

/**
 * `withTransientDemand`'s teardown runs work that can fail on its own.
 *
 * `refreshDemand` reaches the device registry (`nextPendingExpiry` -> `listDevices`) and the
 * settings store (`hasDemand` -> `isRelayAllowedForDevice`). Running it bare in the `finally` let
 * its failure replace the operation's result in BOTH directions: a named mint failure arrived as
 * an unrelated message, and a successful mint arrived as a rejection. Before the operation it was
 * worse still: the throw landed after the transient ref was acquired, so the ref was never
 * released, and transient refs have no expiry.
 */
type TransientDemandHost = {
  withTransientDemand: (
    kind: string,
    deviceId: string,
    operation: () => Promise<unknown>
  ) => Promise<unknown>
}

function serviceWithTeardown(options: {
  release?: () => void
  refreshDemand?: () => void
}): (operation: () => Promise<unknown>) => Promise<unknown> {
  const service = Object.create(DesktopRelayService.prototype) as DesktopRelayService
  Object.assign(service, {
    hostMobilePairingConnectionMode: () => 'automatic' as MobilePairingConnectionMode,
    runtimeRpc: {
      getDeviceRegistry: () => ({ getMobilePairingConnectionMode: () => 'automatic' })
    },
    demandLedger: { acquireTransient: () => options.release ?? ((): void => {}) },
    refreshDemand: options.refreshDemand ?? ((): void => {})
  })
  const host = service as unknown as TransientDemandHost
  return (operation) => host.withTransientDemand.call(service, 'pairing', 'device-1', operation)
}

describe('DesktopRelayService transient-demand teardown', () => {
  it('keeps the operation failure when the demand refresh throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const run = serviceWithTeardown({
      refreshDemand: () => {
        throw new Error('listDevices exploded')
      }
    })

    await expect(
      run(async () => {
        throw new Error('relay_broker_rejected')
      })
    ).rejects.toThrow('relay_broker_rejected')
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('does not strand the demand ref when the pre-operation refresh throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const release = vi.fn()
    const operation = vi.fn(async () => 'minted')
    const run = serviceWithTeardown({
      release,
      refreshDemand: () => {
        throw new Error('listDevices exploded')
      }
    })

    // The ref has no expiry, so failing the wake signal must not take the release with it.
    await expect(run(operation)).resolves.toBe('minted')
    expect(operation).toHaveBeenCalledTimes(1)
    expect(release).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it('keeps a successful mint successful when the demand refresh throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const run = serviceWithTeardown({
      refreshDemand: () => {
        throw new Error('listDevices exploded')
      }
    })

    await expect(run(async () => 'minted')).resolves.toBe('minted')
    warn.mockRestore()
  })

  it('carries the original failure as the cause of a mid-operation policy flip', async () => {
    const mode = { current: 'automatic' as MobilePairingConnectionMode }
    const service = Object.create(DesktopRelayService.prototype) as DesktopRelayService
    Object.assign(service, {
      hostMobilePairingConnectionMode: () => mode.current,
      runtimeRpc: {
        getDeviceRegistry: () => ({ getMobilePairingConnectionMode: () => 'automatic' })
      },
      demandLedger: { acquireTransient: () => (): void => {} },
      refreshDemand: () => {}
    })
    const host = service as unknown as TransientDemandHost

    const rejection = await host.withTransientDemand
      .call(service, 'pairing', 'device-1', async () => {
        mode.current = 'local-only'
        throw new Error('relay_token_exchange_failed_503')
      })
      .catch((error: unknown) => error)

    expect((rejection as Error).message).toBe('relay_disabled_for_device')
    expect(((rejection as Error).cause as Error | undefined)?.message).toBe(
      'relay_token_exchange_failed_503'
    )
  })
})
