import { afterEach, describe, expect, it } from 'vitest'
import { publishPageHostProfile } from '../mobile-web-shell/bridge/page-host-profile'
import { loadHostCatalog, loadHosts, updateLastConnected } from './host-store.web'

const HOST = { id: 'host-1', name: 'Host One', endpoint: 'ws://host-1', lastConnected: 7 }

afterEach(() => {
  publishPageHostProfile(null)
})

describe('the host list a page has', () => {
  it('is the one host init named, with the fields the screens read', async () => {
    publishPageHostProfile(HOST)
    await expect(loadHosts()).resolves.toEqual([{ ...HOST, deviceToken: '', publicKeyB64: '' }])
  })

  it('holds no credential, because the bridge already carries the connection', async () => {
    publishPageHostProfile(HOST)
    const [profile] = await loadHosts()
    expect(profile?.deviceToken).toBe('')
    expect(profile?.publicKeyB64).toBe('')
  })

  it('is empty before init, rather than a host the page invented', async () => {
    await expect(loadHosts()).resolves.toEqual([])
    await expect(loadHostCatalog()).resolves.toEqual([])
  })

  it('answers the catalog the same host, marked as paired, since pairing already happened', async () => {
    publishPageHostProfile(HOST)
    const [entry] = await loadHostCatalog()
    expect(entry?.credentialStatus).toBe('ready')
    expect(entry?.id).toBe('host-1')
  })
})

describe('the writes a page drops', () => {
  it('settles rather than throwing, because recency orders a list the page never shows', async () => {
    publishPageHostProfile(HOST)
    await expect(updateLastConnected('host-1')).resolves.toBeUndefined()
    await expect(loadHosts()).resolves.toHaveLength(1)
  })
})
