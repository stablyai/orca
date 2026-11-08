import { describe, expect, it, vi } from 'vitest'

vi.mock('expo-image-picker', () => ({}))
vi.mock('expo-document-picker', () => ({ getDocumentAsync: vi.fn() }))
vi.mock('expo-file-system', () => ({ File: vi.fn() }))

import '../../platform/media-picker-contract'
import type { PickedMobileFile } from '../../platform/media-picker-contract'
import { pickMobileFiles } from './mobile-file-source-picker'

type Asset = { uri: string; name: string; size?: number; mimeType?: string }

function launcher(assets: Asset[] | null) {
  return vi.fn(async () =>
    assets === null
      ? { canceled: true as const, assets: null }
      : { canceled: false as const, assets: assets.map((asset) => ({ lastModified: 0, ...asset })) }
  )
}

async function collect(files: AsyncIterable<PickedMobileFile>): Promise<PickedMobileFile[]> {
  const taken: PickedMobileFile[] = []
  for await (const file of files) {
    taken.push(file)
  }
  return taken
}

describe('pickMobileFiles', () => {
  it('yields nothing for a cancelled picker', async () => {
    expect(await collect(pickMobileFiles({ launch: launcher(null) }))).toEqual([])
  })
})
