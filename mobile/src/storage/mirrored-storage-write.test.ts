import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The one write path every mirrored key goes through, driven against the page's own store.
 *
 * The adapter is what can refuse — `not-allowed` for a key this route was never given,
 * `too-large` for a value past the frame cap — and ruling 35 puts the mirror note behind that
 * decision. Before it, every writer noted the mirror first and two of them rolled it back by
 * hand: twelve did not, so a refused page write left the app's mirror holding a value the store
 * had never taken, and the next `init` handed the page exactly that.
 *
 * Driven through the real page adapter rather than a stub, because the refusals under test are
 * its own and a stub would be a second opinion about them.
 */
vi.mock('@react-native-async-storage/async-storage', async () => ({
  default: (await import('../mobile-web-shell/bridge/page-async-storage')).default
}))

const { publishPageStorage } = await import('../mobile-web-shell/bridge/page-async-storage')
const { pageStorageEntriesForInit, pageStorageKeysForRoute, PAGE_STORAGE_MAX_VALUE_CHARS } =
  await import('../mobile-web-shell/page-storage-keys')
const { persistMirrored, readMirroredStorage } = await import('./mirrored-storage-keys')

const HOST_ID = 'host-1'
const ROUTE = '/h/host-1/session/wt-1'
const DOCK_WIDTH = 'orca:hostDockWidth'
const OTHER_HOST_PIN = 'orca:pins:host-2'

/** What the shell would put in the next `init` for this route, which is the mirror's one reader. */
function initStorage(): Readonly<Record<string, string>> {
  return pageStorageEntriesForInit(readMirroredStorage(pageStorageKeysForRoute(HOST_ID, ROUTE)))
    .entries
}

beforeEach(() => {
  publishPageStorage({ [DOCK_WIDTH]: '320' }, () => true, HOST_ID, ROUTE)
  // The app's side of the same key, which is what a refused write must leave standing.
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
    // Resolves rather than rejects: a page-closure writer of an unlisted key awaits with no catch.
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
