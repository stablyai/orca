import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Use the real page adapter: its resolved refusals must not put rejected values into the next shell init’s mirror.
vi.mock('@react-native-async-storage/async-storage', async () => ({
  default: (await import('../mobile-web-shell/bridge/page-async-storage')).default
}))

const { publishPageStorage } = await import('../mobile-web-shell/bridge/page-async-storage')
const { pageStorageEntriesForInit, pageStorageKeysForRoute, PAGE_STORAGE_MAX_VALUE_CHARS } =
  await import('../mobile-web-shell/page-storage-keys')
const { persistMirrored, readMirroredStorage, retainMirroredStorage } =
  await import('./mirrored-storage-keys')

const HOST_ID = 'host-1'
const ROUTE = '/h/host-1/session/wt-1'
const DOCK_WIDTH = 'orca:hostDockWidth'
const OTHER_HOST_PIN = 'orca:pins:host-2'
let releaseStorage = () => {}

afterEach(() => releaseStorage())

function initStorage(): Readonly<Record<string, string>> {
  return pageStorageEntriesForInit(readMirroredStorage(pageStorageKeysForRoute(HOST_ID, ROUTE)))
    .entries
}

beforeEach(() => {
  releaseStorage = retainMirroredStorage(pageStorageKeysForRoute(HOST_ID, ROUTE))
  publishPageStorage({ [DOCK_WIDTH]: '320' }, () => true, HOST_ID, ROUTE)
  return persistMirrored(DOCK_WIDTH, '320')
})

describe('the mirrored write path', () => {
  it('leaves the mirror and the next init alone when the store refuses the value', async () => {
    const before = initStorage()
    await expect(
      persistMirrored(DOCK_WIDTH, 'x'.repeat(PAGE_STORAGE_MAX_VALUE_CHARS + 1))
    ).rejects.toThrow('could not save')
    expect(readMirroredStorage([DOCK_WIDTH])[DOCK_WIDTH]).toBe('320')
    expect(initStorage()).toEqual(before)
  })

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

  it('answers a reader with an accepted write, which is what `init` is built from', async () => {
    await persistMirrored(DOCK_WIDTH, '480')
    expect(readMirroredStorage([DOCK_WIDTH])[DOCK_WIDTH]).toBe('480')
    expect(initStorage()[DOCK_WIDTH]).toBe('480')
  })

  it('drops a removed key from the mirror, which is what absent means to `init`', async () => {
    await persistMirrored(DOCK_WIDTH, null)
    expect(readMirroredStorage([DOCK_WIDTH])[DOCK_WIDTH]).toBeUndefined()
    expect(initStorage()[DOCK_WIDTH]).toBeUndefined()
  })
})
