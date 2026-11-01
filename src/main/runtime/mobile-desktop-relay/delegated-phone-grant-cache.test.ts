import { describe, expect, it, vi } from 'vitest'
import {
  DELEGATED_MOBILE_DEVICE_SYNC_MAX_PHONES,
  type DelegatedMobileDeviceSyncParams
} from '../../../shared/delegated-mobile-device-contract'
import type { DelegatedPhoneGrants } from './delegated-phone-grants'
import { DelegatedPhoneGrantCache } from './delegated-phone-grant-cache'
import type { MobileDesktopRelayHost, MobileDesktopRelayHosts } from './mobile-desktop-relay-hosts'

type HeldSync = { phoneKeys: string[]; answer: () => void }
const heldSyncs = vi.hoisted((): HeldSync[] => [])
vi.mock('./delegated-phone-grants', () => ({
  syncDelegatedPhoneGrants: (
    _hosts: MobileDesktopRelayHosts,
    host: MobileDesktopRelayHost,
    phones: DelegatedMobileDeviceSyncParams['phones']
  ) =>
    new Promise<DelegatedPhoneGrants>((resolve) => {
      const phoneKeys = phones.map((phone) => phone.phoneKey)
      heldSyncs.push({
        phoneKeys,
        answer: () =>
          resolve({
            kind: 'ready',
            fence: host.fence,
            grants: new Map(),
            asked: new Set(phoneKeys),
            refused: new Set()
          })
      })
    })
}))

const host: MobileDesktopRelayHost = {
  environmentId: 'env-1',
  fence: 'f',
  pairing: { v: 2, endpoint: 'ws://127.0.0.1:1', deviceToken: 'desktop', publicKeyB64: 'k' }
}
const unusedHosts: MobileDesktopRelayHosts = {
  list: () => ({
    environments: [],
    statusByEnvironmentId: new Map(),
    sshTargetLabels: new Map(),
    sshConnectionStates: new Map()
  }),
  resolve: async () => null,
  call: async () => {
    throw new Error('sync is mocked')
  },
  hostsBrowserPage: () => false,
  onEnvironmentRetired: () => () => {},
  onStatusChanged: () => () => {},
  watchChanges: () => ({ close: () => {}, current: () => true })
}

describe('DelegatedPhoneGrantCache', () => {
  it('re-syncs for a device enrolled while an earlier sync was in flight', async () => {
    const enrolled = ['laptop']
    const cache = new DelegatedPhoneGrantCache(unusedHosts, () =>
      enrolled.map((phoneKey) => ({ phoneKey, name: phoneKey }))
    )

    const first = cache.get(host, 'laptop')
    enrolled.push('browser')
    const second = cache.get(host, 'browser')
    heldSyncs[0]?.answer()
    await first
    await vi.waitFor(() => expect(heldSyncs).toHaveLength(2))
    expect(heldSyncs[1]?.phoneKeys).toEqual(['laptop', 'browser'])
    heldSyncs[1]?.answer()

    const grants = await second
    expect(grants.kind === 'ready' && grants.asked.has('browser')).toBe(true)
  })

  it('refuses a device past the sync cap without syncing for it', async () => {
    const phones = Array.from({ length: DELEGATED_MOBILE_DEVICE_SYNC_MAX_PHONES }, (_, i) => ({
      phoneKey: `phone-${i}`,
      name: `Phone ${i}`
    }))
    const cache = new DelegatedPhoneGrantCache(unusedHosts, () => [
      ...phones,
      { phoneKey: 'laptop', name: 'Laptop' }
    ])
    const syncsBefore = heldSyncs.length

    await expect(cache.get(host, 'laptop')).rejects.toMatchObject({
      code: 'remote_runtime_unavailable'
    })
    expect(heldSyncs).toHaveLength(syncsBefore)
  })
})
