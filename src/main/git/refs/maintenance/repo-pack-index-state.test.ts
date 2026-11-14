import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { probeRepoPackIndexDirectory } from './repo-pack-index-state'

const roots: string[] = []
async function directory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-pack-index-state-'))
  roots.push(root)
  return root
}

function indexHeader(version = 1, hash = 1): Buffer {
  const value = Buffer.alloc(1200)
  value.write('MIDX')
  value[4] = version
  value[5] = hash
  value[6] = 4
  return value
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('pack-index metadata protection', () => {
  it('protects every retained bitmap regardless of its checksum', async () => {
    const packs = await directory()
    await writeFile(join(packs, 'multi-pack-index'), indexHeader())
    await writeFile(join(packs, 'multi-pack-index-old.bitmap'), 'retained bitmap')
    await expect(
      probeRepoPackIndexDirectory(packs, 64, new AbortController().signal)
    ).resolves.toMatchObject({ protected: true })
  })

  it('protects an incremental chain without reading its layers', async () => {
    const packs = await directory()
    await mkdir(join(packs, 'multi-pack-index.d'))
    await expect(
      probeRepoPackIndexDirectory(packs, 64, new AbortController().signal)
    ).resolves.toMatchObject({ protected: true })
  })

  it.each([indexHeader(2), indexHeader(1, 3), Buffer.from('MIDX'), Buffer.alloc(1200)])(
    'fails closed on an unknown or truncated MIDX',
    async (header) => {
      const packs = await directory()
      await writeFile(join(packs, 'multi-pack-index'), header)
      await expect(
        probeRepoPackIndexDirectory(packs, 64, new AbortController().signal)
      ).resolves.toMatchObject({ protected: true })
    }
  )

  it.each([1, 2])('accepts the standalone v1 SHA hash format %s', async (hash) => {
    const packs = await directory()
    await writeFile(join(packs, 'multi-pack-index'), indexHeader(1, hash))
    await expect(
      probeRepoPackIndexDirectory(packs, 64, new AbortController().signal)
    ).resolves.toEqual({ protected: false, packCountFloor: 0 })
  })
})
