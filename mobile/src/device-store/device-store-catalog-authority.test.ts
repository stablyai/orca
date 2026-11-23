import { expect, it, vi } from 'vitest'
import { createFakeGenerationFileSystem } from '../mobile-web-shell/generations/generation-file-system-fake'
import { watchHostRevocation } from '../transport/connection/host-revocation-watch'
import type { ConnectionState } from '../transport/connection/connection-state'
import { deviceStoreRows, hostDirectoryUri } from './device-store-files'
import { encodeDeviceStoreValue } from './device-store-value-codec'
import { createDeviceStore } from './device-store'

vi.mock('expo-file-system', () => ({ Directory: undefined, File: undefined, Paths: {} }))
vi.mock('react-native', () => ({ AppState: {}, Platform: { OS: 'ios' } }))
vi.mock('../host-credentials/pairing-keychain', () => ({
  readPairingKeychainItem: undefined,
  writePairingKeychainItem: undefined
}))
vi.mock('../host-catalog/host-metadata-store', () => ({ loadStoredHostProfiles: undefined }))

it('reopens a surviving sealed catalog only for its authenticated desktop after a failed wipe', async () => {
  const fs = createFakeGenerationFileSystem()
  const roots = { cache: fs.rootUri, draft: `${fs.rootUri}/draft` }
  const desktop = 'same-public-key'
  const localeKey = 'i18n-catalog:ru'
  const surviving = encodeDeviceStoreValue({
    v: 1,
    sha256: 'a'.repeat(64),
    catalog: { title: 'Русский' }
  })
  const store = createDeviceStore({
    fileSystem: {
      ...fs,
      async delete(uri) {
        if (uri === hostDirectoryUri(roots, 'cache', desktop)) {
          throw new Error('fixture wipe failure')
        }
        await fs.delete(uri)
      }
    },
    roots,
    keychain: { read: async () => 'b'.repeat(64), write: async () => {} },
    loadPairedHostIds: async () => [desktop]
  })
  expect(await store.write(desktop, 'cache', [{ key: localeKey, value: surviving }])).toEqual({
    written: true
  })
  store.fenceHostCache(desktop, true)
  await expect(store.wipeHost(desktop, ['cache'])).rejects.toThrow('fixture wipe failure')

  let state: ConnectionState = 'connecting'
  let changed: (() => void) | undefined
  const stop = watchHostRevocation(
    {
      getState: () => state,
      getActivePath: () => 'lan',
      isPairingRejected: () => false,
      onStateChange: (listener) => {
        changed = () => listener(state)
        return () => {}
      },
      onConnectionPathChange: () => () => {}
    },
    (revoked) => store.fenceHostCache(desktop, revoked)
  )
  try {
    expect(await store.read(desktop, 'cache', [localeKey])).toEqual({ status: 'unavailable' })
    expect(await store.write(desktop, 'cache', [{ key: localeKey, value: null }])).toEqual({
      written: false,
      refusal: 'unavailable'
    })
    state = 'connected'
    changed?.()
    expect(await store.read(desktop, 'cache', [localeKey])).toEqual({
      status: 'ok',
      values: [surviving]
    })

    const [original] = deviceStoreRows(roots, desktop, 'cache', [localeKey])
    const [other] = deviceStoreRows(roots, 'other-desktop', 'cache', [localeKey])
    await fs.copyFile(original!.uri, other!.uri)
    expect(await store.read('other-desktop', 'cache', [localeKey])).toEqual({
      status: 'ok',
      values: [null]
    })
  } finally {
    stop()
  }
})
