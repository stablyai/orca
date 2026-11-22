import { beforeEach, describe, expect, it } from 'vitest'
import { readShellRefusalCode } from '../host-bridge/bridge-host-errors'

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
})
