import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { stageManifest } from './adhoc-mac-manifests.mjs'

const version = '1.2.3-adhoc.20261021'
const content = Buffer.from('signed and stapled archive')
const sha512 = createHash('sha512').update(content).digest('base64')
function record(arch) {
  const names = [
    `Orca-${version}${arch === 'arm64' ? '-arm64' : ''}-mac.zip`,
    `orca-macos-${arch}.dmg`
  ]
  return {
    arch,
    manifest: {
      version,
      path: names[0],
      sha512,
      releaseDate: '2026-10-21T00:00:00Z',
      files: names.map((url) => ({ url, sha512, size: content.length }))
    },
    assets: names.flatMap((name) => [
      { name, size: content.length },
      { name: `${name}.blockmap`, size: 4 }
    ])
  }
}

describe('parallel Mac updater manifests', () => {
  it('checks the actual archive hashes before permitting upload', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mac-manifest-'))
    try {
      const item = record('arm64')
      for (const asset of item.assets) {
        await writeFile(
          join(directory, asset.name),
          asset.name.endsWith('.blockmap') ? 'map!' : content
        )
      }
      expect(await stageManifest(item.manifest, item.arch, version, directory)).toEqual(item)
      await writeFile(join(directory, item.manifest.path), Buffer.alloc(content.length))
      await expect(stageManifest(item.manifest, item.arch, version, directory)).rejects.toThrow(
        'checksum or size'
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
