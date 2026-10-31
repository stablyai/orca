import { describe, expect, it } from 'vitest'
import {
  DelegatedMobileDeviceSyncParamsSchema,
  DELEGATED_MOBILE_DEVICE_SYNC_MAX_PHONES,
  DELEGATED_MOBILE_DEVICES_RUNTIME_CAPABILITY
} from '../../../shared/delegated-mobile-device-contract'
import { syncDelegatedPhoneGrants } from './delegated-phone-grants'
import type { MobileDesktopRelayHost, MobileDesktopRelayHosts } from './mobile-desktop-relay-hosts'

const host: MobileDesktopRelayHost = {
  environmentId: 'env-1',
  fence: 'f',
  pairing: { v: 2, endpoint: 'ws://127.0.0.1:1', deviceToken: 'desktop', publicKeyB64: 'k' }
}

function grantingHosts(): MobileDesktopRelayHosts {
  return {
    list: () => ({
      environments: [],
      statusByEnvironmentId: new Map(),
      sshTargetLabels: new Map(),
      sshConnectionStates: new Map()
    }),
    resolve: async () => host,
    call: async (_host, method, params) => {
      const result =
        method === 'status.get'
          ? { capabilities: [DELEGATED_MOBILE_DEVICES_RUNTIME_CAPABILITY] }
          : {
              devices: DelegatedMobileDeviceSyncParamsSchema.parse(params).phones.map((phone) => ({
                phoneKey: phone.phoneKey,
                deviceId: `child-${phone.phoneKey}`,
                token: `token-${phone.phoneKey}`
              }))
            }
      return { id: 'x', ok: true, result, _meta: { runtimeId: 'b' } }
    },
    hostsBrowserPage: () => false,
    onEnvironmentRetired: () => () => {},
    onStatusChanged: () => () => {},
    watchChanges: () => ({ close: () => {}, current: () => true })
  }
}

describe('syncDelegatedPhoneGrants', () => {
  it('counts only devices the sync sent as asked, so one cut by the cap re-syncs later', async () => {
    const devices = Array.from({ length: DELEGATED_MOBILE_DEVICE_SYNC_MAX_PHONES + 1 }, (_, i) => ({
      phoneKey: `device-${i}`,
      name: `Device ${i}`
    }))
    const cut = devices[DELEGATED_MOBILE_DEVICE_SYNC_MAX_PHONES]!.phoneKey

    const grants = await syncDelegatedPhoneGrants(grantingHosts(), host, devices)

    expect(grants.kind).toBe('ready')
    if (grants.kind !== 'ready') {
      return
    }
    expect(grants.asked.has('device-0')).toBe(true)
    expect(grants.asked.has(cut)).toBe(false)
    expect(grants.grants.has(cut)).toBe(false)
  })
})
