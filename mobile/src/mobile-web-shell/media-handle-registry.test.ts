/** Every way a staged handle ends, and every refusal a page gets for one that has. */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readShellRefusalCode } from './bridge-host-errors'
import {
  BRIDGE_MEDIA_MAX_LIVE_HANDLES,
  BRIDGE_MEDIA_READ_MAX_BYTES
} from './bridge/bridge-media-verbs'
import { MEDIA_HANDLE_TTL_MS, MediaHandleRegistry, type StagedMedia } from './media-handle-registry'

const staged = (index: number, byteLength = 3000): StagedMedia => ({
  uri: `file:///cache/orca-media-${index}.png`,
  mime: 'image/png',
  byteLength,
  width: 10,
  height: 8
})

function refusalOf(run: () => unknown): string | null {
  try {
    run()
  } catch (error) {
    return readShellRefusalCode(error)
  }
  throw new Error('that call was expected to refuse and did not')
}

describe('the lifetime this registry states', () => {
  it('sweeps a staged file five minutes after the last touch', () => {
    // A literal, because five minutes is the number the body claims and the docstring derives.
    expect(MEDIA_HANDLE_TTL_MS).toBe(5 * 60 * 1000)
    expect(MEDIA_HANDLE_TTL_MS).toBe(300_000)
  })
})

describe('minting handles', () => {
  let clock = 1_000
  let deleted: string[] = []
  let registry: MediaHandleRegistry

  beforeEach(() => {
    clock = 1_000
    deleted = []
    registry = new MediaHandleRegistry({
      now: () => clock,
      discard: (uri) => deleted.push(uri)
    })
  })

  it('answers one item per staged file, each with a handle of its own', () => {
    const items = registry.mint([staged(1), staged(2)])
    expect(items.map((item) => item.mime)).toEqual(['image/png', 'image/png'])
    expect(items.map((item) => item.byteLength)).toEqual([3000, 3000])
    expect(items[0]?.handle).not.toBe(items[1]?.handle)
    expect(registry.liveCount()).toBe(2)
  })

  it('carries the pixel dimensions only when the picker reported them', () => {
    const [withSize, withoutSize] = registry.mint([
      staged(1),
      { uri: 'file:///cache/a.pdf', mime: 'application/pdf', byteLength: 12 }
    ])
    expect(withSize).toMatchObject({ width: 10, height: 8 })
    expect(withoutSize).not.toHaveProperty('width')
    expect(withoutSize).not.toHaveProperty('height')
  })

  it('refuses a pick that would pass the live-handle cap, and stages nothing of it', () => {
    registry.mint(Array.from({ length: BRIDGE_MEDIA_MAX_LIVE_HANDLES }, (_, i) => staged(i)))
    const extra = staged(99)
    expect(refusalOf(() => registry.mint([extra]))).toBe('native_media_handle_cap')
    // Refused whole: the file this pick staged is discarded, not left in the cache unreferenced.
    expect(deleted).toEqual([extra.uri])
    expect(registry.liveCount()).toBe(BRIDGE_MEDIA_MAX_LIVE_HANDLES)
  })

  it('sweeps what the TTL expired before it decides the cap is full', () => {
    registry.mint(Array.from({ length: BRIDGE_MEDIA_MAX_LIVE_HANDLES }, (_, i) => staged(i)))
    clock += MEDIA_HANDLE_TTL_MS + 1
    const items = registry.mint([staged(99)])
    expect(items).toHaveLength(1)
    expect(registry.liveCount()).toBe(1)
    expect(deleted).toHaveLength(BRIDGE_MEDIA_MAX_LIVE_HANDLES)
  })
})

describe('reading a handle', () => {
  let clock = 1_000
  let deleted: string[] = []
  let registry: MediaHandleRegistry

  beforeEach(() => {
    clock = 1_000
    deleted = []
    registry = new MediaHandleRegistry({ now: () => clock, discard: (uri) => deleted.push(uri) })
  })

  it('answers the byte range a chunk covers, and says which one ends the file', () => {
    const [item] = registry.mint([staged(1, 1000)])
    const handle = item?.handle ?? ''
    expect(registry.read(handle, 0, 400)).toEqual({
      uri: 'file:///cache/orca-media-1.png',
      start: 0,
      end: 400,
      eof: false
    })
    expect(registry.read(handle, 600, 400)).toMatchObject({ start: 600, end: 1000, eof: true })
  })

  it('shortens the last chunk rather than reading past the file', () => {
    const [item] = registry.mint([staged(1, 1000)])
    expect(registry.read(item?.handle ?? '', 900, 400)).toMatchObject({ end: 1000, eof: true })
  })

  it('reads an empty staged file once, and calls it the end', () => {
    const [item] = registry.mint([staged(1, 0)])
    expect(registry.read(item?.handle ?? '', 0, 400)).toMatchObject({ start: 0, end: 0, eof: true })
  })

  it('never hands back more than one chunk, whatever length it was asked for', () => {
    // The wire cannot ask this — the params schema refuses it first — and the registry answers it
    // anyway, because what it will hand a reader is its own promise and not the schema's.
    const [item] = registry.mint([staged(1, BRIDGE_MEDIA_READ_MAX_BYTES * 3)])
    const range = registry.read(item?.handle ?? '', 0, BRIDGE_MEDIA_READ_MAX_BYTES * 3)
    expect(range.end).toBe(BRIDGE_MEDIA_READ_MAX_BYTES)
    expect(range.eof).toBe(false)
  })

  it('refuses a read at or past the end of a file that had bytes', () => {
    const [item] = registry.mint([staged(1, 1000)])
    const handle = item?.handle ?? ''
    expect(refusalOf(() => registry.read(handle, 1000, 16))).toBe('native_media_range')
    expect(refusalOf(() => registry.read(handle, 4000, 16))).toBe('native_media_range')
  })

  it('refuses a handle it never minted, one it released, and one the TTL swept', () => {
    const [item] = registry.mint([staged(1)])
    const handle = item?.handle ?? ''
    expect(refusalOf(() => registry.read('never-minted', 0, 16))).toBe(
      'native_media_handle_unknown'
    )
    registry.release(handle)
    expect(refusalOf(() => registry.read(handle, 0, 16))).toBe('native_media_handle_unknown')

    const [second] = registry.mint([staged(2)])
    clock += MEDIA_HANDLE_TTL_MS + 1
    expect(refusalOf(() => registry.read(second?.handle ?? '', 0, 16))).toBe(
      'native_media_handle_unknown'
    )
  })

  it('keeps a handle alive while the page is still reading it', () => {
    const [item] = registry.mint([staged(1, 10_000)])
    const handle = item?.handle ?? ''
    for (let offset = 0; offset < 10_000; offset += 1000) {
      clock += MEDIA_HANDLE_TTL_MS - 1
      expect(registry.read(handle, offset, 1000).start).toBe(offset)
    }
    expect(registry.liveCount()).toBe(1)
  })
})

describe('ending a handle', () => {
  let deleted: string[] = []
  let registry: MediaHandleRegistry

  beforeEach(() => {
    deleted = []
    registry = new MediaHandleRegistry({ now: () => 1_000, discard: (uri) => deleted.push(uri) })
  })

  it('deletes the staged file and says it released one', () => {
    const [item] = registry.mint([staged(1)])
    expect(registry.release(item?.handle ?? '')).toBe(true)
    expect(deleted).toEqual(['file:///cache/orca-media-1.png'])
    expect(registry.liveCount()).toBe(0)
  })

  it('answers false for a handle the TTL already expired, as the wire contract says', () => {
    // `release` was the one lifetime path that did not sweep first, so an expired handle was still
    // in the map when it looked and the page was told `released: true` for a file the next sweep
    // would have taken anyway. `mediaReleaseParamsSchema`'s own docstring promises the opposite.
    let clock = 1_000
    const swept: string[] = []
    const ageing = new MediaHandleRegistry({
      now: () => clock,
      discard: (uri) => swept.push(uri)
    })
    const [item] = ageing.mint([staged(1)])
    clock += MEDIA_HANDLE_TTL_MS + 1
    expect(ageing.release(item?.handle ?? '')).toBe(false)
    // Swept, not leaked: the file goes either way, and only the answer differs.
    expect(swept).toEqual(['file:///cache/orca-media-1.png'])
  })

  it('is gone at exactly the TTL, not one millisecond after', () => {
    let clock = 1_000
    const ageing = new MediaHandleRegistry({ now: () => clock, discard: () => {} })
    const [item] = ageing.mint([staged(1)])
    const handle = item?.handle ?? ''
    clock += MEDIA_HANDLE_TTL_MS - 1
    expect(ageing.liveCount()).toBe(1)
    clock += 1
    expect(ageing.liveCount()).toBe(0)
    expect(ageing.release(handle)).toBe(false)
  })

  it('answers false for a handle it no longer holds, rather than refusing', () => {
    // Releasing twice, or after the TTL swept, asks for the state the page already has. A refusal
    // there would make an unmount path that cannot know which handles survived look like a fault.
    const [item] = registry.mint([staged(1)])
    registry.release(item?.handle ?? '')
    expect(registry.release(item?.handle ?? '')).toBe(false)
    expect(registry.release('never-minted')).toBe(false)
    expect(deleted).toHaveLength(1)
  })

  it('releases everything at once, which is what the session end and the unmount call', () => {
    registry.mint([staged(1), staged(2), staged(3)])
    registry.releaseAll()
    expect(deleted).toHaveLength(3)
    expect(registry.liveCount()).toBe(0)
    // Idempotent: a session that ends under an unmount reaches this twice.
    registry.releaseAll()
    expect(deleted).toHaveLength(3)
  })

  it('keeps going when the device refuses to delete one staged file', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const failing = new MediaHandleRegistry({
      now: () => 1_000,
      discard: (uri) => {
        if (uri.endsWith('2.png')) {
          throw new Error('the OS reclaimed it first')
        }
        deleted.push(uri)
      }
    })
    failing.mint([staged(1), staged(2), staged(3)])
    failing.releaseAll()
    expect(deleted).toHaveLength(2)
    expect(failing.liveCount()).toBe(0)
    warn.mockRestore()
  })
})
