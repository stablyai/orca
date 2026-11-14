import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Use the real page adapter: its resolved refusals must not put rejected values into the next shell init’s mirror.
vi.mock('@react-native-async-storage/async-storage', async () => ({
  default: (await import('../mobile-web-shell/bridge/page-storage/page-async-storage')).default
}))

const { publishPageStorage } =
  await import('../mobile-web-shell/bridge/page-storage/page-async-storage')
const { pageStorageKeysForRoute } =
  await import('../mobile-web-shell/page-storage/page-storage-keys')
const { persistMirrored, readMirroredStorage, retainMirroredStorage } =
  await import('./mirrored-storage-keys')

const HOST_ID = 'host-1'
const ROUTE = '/h/host-1/session/wt-1'
const DOCK_WIDTH = 'orca:hostDockWidth'
const OTHER_HOST_PIN = 'orca:pins:host-2'
let releaseStorage = () => {}

afterEach(() => releaseStorage())

beforeEach(() => {
  releaseStorage = retainMirroredStorage(pageStorageKeysForRoute(HOST_ID, ROUTE))
  publishPageStorage({ [DOCK_WIDTH]: '320' }, () => true, HOST_ID, ROUTE)
  return persistMirrored(DOCK_WIDTH, '320')
})

describe('the mirrored write path', () => {
  it('leaves them alone for a key this route was never given, and logs the drop', async () => {
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    // Unlisted-key writes resolve because page callers may await them without a catch.
    await expect(persistMirrored(OTHER_HOST_PIN, '["a"]')).resolves.toBeUndefined()
    expect(readMirroredStorage([OTHER_HOST_PIN])[OTHER_HOST_PIN]).toBeUndefined()
    expect(warned).toHaveBeenCalledWith(
      '[page-bridge] storage-write-dropped',
      expect.objectContaining({ key: OTHER_HOST_PIN, refusal: 'not-allowed' })
    )
    warned.mockRestore()
  })
})
