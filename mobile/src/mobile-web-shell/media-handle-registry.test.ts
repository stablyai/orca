import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readShellRefusalCode } from './bridge-host-errors'
import { BRIDGE_MEDIA_MAX_LIVE_HANDLES } from './bridge/bridge-media-verbs'
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

  it('refuses a pick that would pass the live-handle cap, and stages nothing of it', () => {
    registry.mint(Array.from({ length: BRIDGE_MEDIA_MAX_LIVE_HANDLES }, (_, i) => staged(i)))
    const extra = staged(99)
    expect(refusalOf(() => registry.mint([extra]))).toBe('native_media_handle_cap')
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

  it('answers false for a handle it no longer holds, rather than refusing', () => {
    // Repeated/expired release is normal during unmount, whose caller cannot know which handles survived.
    const [item] = registry.mint([staged(1)])
    registry.release(item?.handle ?? '')
    expect(registry.release(item?.handle ?? '')).toBe(false)
    expect(registry.release('never-minted')).toBe(false)
    expect(deleted).toHaveLength(1)
  })

  it('keeps going when the device refuses to delete one staged file', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
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
      expect(deleted).toEqual([staged(1).uri, staged(3).uri])
      expect(failing.liveCount()).toBe(0)
    } finally {
      warn.mockRestore()
    }
  })
})
