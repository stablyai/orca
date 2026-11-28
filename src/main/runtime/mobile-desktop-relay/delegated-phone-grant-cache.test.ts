import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { removeTreeSync } from '../../../shared/file-write/windows-transient-lock-removal'
import {
  DELEGATED_MOBILE_DEVICE_SYNC_METHOD,
  DELEGATED_MOBILE_DEVICES_RUNTIME_CAPABILITY,
  DelegatedMobileDeviceSyncParamsSchema,
  type DelegatedPhone
} from '../../../shared/remote-runtime/pairing/delegated-mobile-device-contract'
import { PAIRING_OFFER_VERSION } from '../../../shared/remote-runtime/pairing/mobile-relay-pairing-offer'
import type { RuntimeRpcResponse } from '../../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import { DelegatedPhoneGrantCache } from './delegated-phone-grant-cache'
import type { MobileDesktopRelayHost, MobileDesktopRelayHosts } from './mobile-desktop-relay-hosts'
import { RelayedPhoneServers } from './relayed-phone-servers'

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((dir) => removeTreeSync(dir)))

const host: MobileDesktopRelayHost = {
  environmentId: 'server',
  fence: 'fence',
  pairing: {
    v: PAIRING_OFFER_VERSION,
    endpoint: 'ws://127.0.0.1:1',
    deviceToken: 't',
    publicKeyB64: 'k'
  }
}
const kept = { phoneKey: 'kept', name: 'Kept' }
const unpaired = { phoneKey: 'unpaired', name: 'Unpaired' }
const answer = (result: unknown): RuntimeRpcResponse<unknown> => ({
  id: 'reply',
  ok: true,
  result,
  _meta: { runtimeId: 'server-runtime' }
})

/** A desktop relaying to one server; each `launch` is a fresh process over the same user data. */
function relayingDesktop() {
  const userData = mkdtempSync(join(tmpdir(), 'orca-relayed-phones-'))
  dirs.push(userData)
  const synced: string[][] = []
  let phones: DelegatedPhone[] | null = [kept, unpaired]
  let holdSyncs: Promise<void> | null = null
  const launch = () => {
    let contact: Parameters<MobileDesktopRelayHosts['onStatusChanged']>[0] = () => {}
    const hosts: MobileDesktopRelayHosts = {
      list: () => ({
        environments: [],
        statusByEnvironmentId: new Map(),
        sshTargetLabels: new Map(),
        sshConnectionStates: new Map()
      }),
      resolve: async () => host,
      call: async (_host, method, params) => {
        if (method === 'status.get') {
          return answer({ capabilities: [DELEGATED_MOBILE_DEVICES_RUNTIME_CAPABILITY] })
        }
        expect(method).toBe(DELEGATED_MOBILE_DEVICE_SYNC_METHOD)
        const sent = DelegatedMobileDeviceSyncParamsSchema.parse(params).phones
        synced.push(sent.map((phone) => phone.phoneKey))
        await holdSyncs
        return answer({ devices: [] })
      },
      hostsBrowserPage: () => false,
      onEnvironmentRetired: () => () => {},
      onStatusChanged: (listener) => {
        contact = listener
        return () => {}
      },
      watchChanges: () => ({ close: () => {}, current: () => false })
    }
    const cache = new DelegatedPhoneGrantCache(
      hosts,
      () => phones,
      new RelayedPhoneServers(userData)
    )
    return {
      cache,
      contact: (inContact: boolean) => contact({ environmentId: 'server', inContact })
    }
  }
  return {
    synced,
    launch,
    setPhones: (next: DelegatedPhone[] | null) => {
      phones = next
    },
    holdSyncs: () => {
      let release = (): void => {}
      holdSyncs = new Promise((resolve) => {
        release = resolve
      })
      return () => {
        holdSyncs = null
        release()
      }
    }
  }
}

describe('DelegatedPhoneGrantCache revocation reach', () => {
  it('sends a phone dropped while the server was unreachable once it is back, across a restart', async () => {
    const desktop = relayingDesktop()
    const first = desktop.launch()
    // Never held this desktop's phones: first contact sends nothing (the relayed request below is first).
    first.contact(true)
    await first.cache.get(host, 'kept')
    expect(desktop.synced).toEqual([['kept', 'unpaired']])

    first.contact(false)
    desktop.setPhones([kept])
    first.cache.phonesChanged()

    const second = desktop.launch()
    second.contact(true)
    await vi.waitFor(() => expect(desktop.synced).toEqual([['kept', 'unpaired'], ['kept']]))

    // Contact flaps and added phones send nothing; the next drop is the next sync.
    second.contact(false)
    second.contact(true)
    desktop.setPhones([kept, { phoneKey: 'added', name: 'Added' }])
    second.cache.phonesChanged()
    desktop.setPhones([])
    second.cache.phonesChanged()
    await vi.waitFor(() => expect(desktop.synced).toEqual([['kept', 'unpaired'], ['kept'], []]))
  })

  it('sends a phone dropped while the previous removal is still on its way', async () => {
    const desktop = relayingDesktop()
    const first = desktop.launch()
    first.contact(true)
    desktop.setPhones([kept, unpaired, { phoneKey: 'third', name: 'Third' }])
    await first.cache.get(host, 'kept')
    const release = desktop.holdSyncs()
    desktop.setPhones([kept, unpaired])
    first.cache.phonesChanged()
    await vi.waitFor(() => expect(desktop.synced).toHaveLength(2))
    desktop.setPhones([kept])
    first.cache.phonesChanged()
    release()
    await vi.waitFor(() =>
      expect(desktop.synced).toEqual([
        ['kept', 'unpaired', 'third'],
        ['kept', 'unpaired'],
        ['kept']
      ])
    )
  })

  it('never sends an unreadable phone list as empty, and checks once it is readable', async () => {
    const desktop = relayingDesktop()
    await desktop.launch().cache.get(host, 'kept')
    desktop.setPhones(null)
    const second = desktop.launch()
    second.contact(true)
    second.cache.phonesChanged()

    desktop.setPhones([kept])
    second.cache.phonesChanged()
    await vi.waitFor(() => expect(desktop.synced).toEqual([['kept', 'unpaired'], ['kept']]))
  })
})
