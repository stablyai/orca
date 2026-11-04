import { describe, expect, it, vi } from 'vitest'

vi.mock('expo-image-picker', () => ({}))
vi.mock('expo-document-picker', () => ({ getDocumentAsync: vi.fn() }))
vi.mock('expo-file-system', () => ({ File: vi.fn() }))

import {
  MOBILE_PICKED_FILE_MAX_BYTES,
  MobileFileTooLargeError,
  type PickedMobileFile
} from '../platform/media-picker-contract'
import { pickMobileFiles } from './mobile-file-source-picker'

type Asset = { uri: string; name: string; size?: number; mimeType?: string }

function launcher(assets: Asset[] | null) {
  return vi.fn(async () =>
    assets === null
      ? { canceled: true as const, assets: null }
      : { canceled: false as const, assets: assets.map((asset) => ({ lastModified: 0, ...asset })) }
  )
}

function filesByUri(contents: Record<string, Uint8Array>, closed?: string[]) {
  return (uri: string) => {
    const bytes = contents[uri] ?? new Uint8Array()
    return {
      size: bytes.byteLength,
      open: () => {
        let done = false
        return {
          size: bytes.byteLength,
          readBytes: () => {
            const chunk = done ? new Uint8Array() : bytes
            done = true
            return chunk
          },
          close: () => closed?.push(uri)
        }
      }
    }
  }
}

async function collect(files: AsyncIterable<PickedMobileFile>): Promise<PickedMobileFile[]> {
  const taken: PickedMobileFile[] = []
  for await (const file of files) {
    taken.push(file)
  }
  return taken
}

describe('pickMobileFiles', () => {
  it('reads each picked file with its own name and type', async () => {
    const closed: string[] = []
    const launch = launcher([
      { uri: 'file:///c/a', name: 'spec.pdf', mimeType: 'application/pdf', size: 3 },
      { uri: 'file:///c/b', name: 'notes' }
    ])
    const files = await collect(
      pickMobileFiles({
        launch,
        createFile: filesByUri(
          {
            'file:///c/a': new Uint8Array([1, 2, 3]),
            'file:///c/b': new Uint8Array([4])
          },
          closed
        )
      })
    )
    expect(files).toEqual([
      { name: 'spec.pdf', mime: 'application/pdf', byteLength: 3, base64: 'AQID' },
      { name: 'notes', mime: 'application/octet-stream', byteLength: 1, base64: 'BA==' }
    ])
    expect(closed).toEqual(['file:///c/a', 'file:///c/b'])
    expect(launch).toHaveBeenCalledWith({ type: '*/*', multiple: true, copyToCacheDirectory: true })
  })

  it('yields nothing for a cancelled picker', async () => {
    expect(await collect(pickMobileFiles({ launch: launcher(null) }))).toEqual([])
  })

  it('refuses a file over the cap by name before reading a byte of it', async () => {
    const createFile = vi.fn(filesByUri({}))
    const refused = await collect(
      pickMobileFiles({
        launch: launcher([
          { uri: 'file:///c/big', name: 'clip.mov', size: MOBILE_PICKED_FILE_MAX_BYTES + 1 }
        ]),
        createFile
      })
    ).catch((error: unknown) => error)
    expect(refused).toBeInstanceOf(MobileFileTooLargeError)
    expect(refused instanceof MobileFileTooLargeError && refused.message).toMatch(
      /^clip.mov is over/
    )
    expect(createFile).not.toHaveBeenCalled()
  })
})
