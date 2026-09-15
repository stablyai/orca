import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setManagedHookInstallDecisionResolver } from './managed-hook-install-policy'
import {
  isWslGuestManagedHookInstallAllowed,
  isWslHookRelayAllowed,
  type WslHookRelayManagerDeps
} from './wsl-hook-relay-deps'
import { runWslRelayGuestInstall } from './wsl-hook-relay-guest-install'
import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'

const { installWslGuestHooksMock, requestOverlayMock } = vi.hoisted(() => ({
  installWslGuestHooksMock: vi.fn(async () => undefined),
  requestOverlayMock: vi.fn(async () => ({ kind: 'none' }) as const)
}))

vi.mock('./wsl-hook-fs-adapter', () => ({ installWslGuestHooks: installWslGuestHooksMock }))
vi.mock('./wsl-guest-plugin-install', () => ({
  requestGuestOpenCodeOverlayDir: requestOverlayMock
}))

function relayDeps(enabled?: boolean): WslHookRelayManagerDeps {
  return {
    platform: () => 'win32',
    remoteHooksEnabled: () => true,
    managedHookSettings: () => (enabled === undefined ? {} : { agentStatusHooksEnabled: enabled })
  } as unknown as WslHookRelayManagerDeps
}

function guestDeps(enabled?: boolean) {
  return {
    installHooks: vi.fn(),
    installCodex: vi.fn(),
    managedHookSettings: relayDeps(enabled).managedHookSettings,
    pluginSources: () => ({ opencodePluginSource: '' }),
    warn: vi.fn()
  }
}

beforeEach(() => {
  installWslGuestHooksMock.mockClear()
  requestOverlayMock.mockClear()
  setManagedHookInstallDecisionResolver(null)
})

afterEach(() => setManagedHookInstallDecisionResolver(null))

describe('WSL hook relay install authorization', () => {
  it('starts the relay for an installation that is not deferring', () => {
    expect(isWslHookRelayAllowed(relayDeps())).toBe(true)
  })

  it('does not start the relay while the first-run question is unanswered', () => {
    setManagedHookInstallDecisionResolver(() => ({ kind: 'defer', reason: 'onboarding-pending' }))

    expect(isWslHookRelayAllowed(relayDeps())).toBe(false)
  })

  it('does not start the relay with hooks turned off', () => {
    expect(isWslHookRelayAllowed(relayDeps(false))).toBe(false)
  })

  it('is what the guest install pass consults too', () => {
    setManagedHookInstallDecisionResolver(() => ({ kind: 'defer', reason: 'onboarding-pending' }))

    expect(isWslGuestManagedHookInstallAllowed(guestDeps())).toBe(false)
  })
})

describe('runWslRelayGuestInstall', () => {
  const mux = { isDisposed: () => false } as unknown as SshChannelMultiplexer

  it("writes nothing in the guest's home while the install is deferred", async () => {
    setManagedHookInstallDecisionResolver(() => ({ kind: 'defer', reason: 'onboarding-pending' }))
    const state = { distro: 'Ubuntu' }

    await runWslRelayGuestInstall(guestDeps(), state, mux, '/home/tester')

    // The rate-limited rerun fires on a live relay, long after the start gate answered.
    expect(installWslGuestHooksMock).not.toHaveBeenCalled()
    expect(state).not.toHaveProperty('lastInstallAt')
  })

  it('installs in the guest when the install is allowed', async () => {
    await runWslRelayGuestInstall(guestDeps(), { distro: 'Ubuntu' }, mux, '/home/tester')

    expect(installWslGuestHooksMock).toHaveBeenCalledTimes(1)
  })
})
