import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { mergeManifests, stageManifest, validateManifest } from './adhoc-mac-manifests.mjs'

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
const records = () => [record('arm64'), record('x64')]
const uploaded = (items) => items.flatMap((item) => item.assets)

describe('parallel Mac updater manifests', () => {
  it('merges both architectures and roundtrips through the updater YAML parser', () => {
    const items = records()
    const result = parse(JSON.stringify(mergeManifests(items, version, uploaded(items))))
    expect(result.files).toHaveLength(4)
    expect(result.path).toBe(items[0].manifest.path)
    expect(result.sha512).toBe(sha512)
    expect(result.releaseDate).toBe(items[0].manifest.releaseDate)
  })

  it.each(['missing', 'duplicate', 'version', 'path', 'checksum', 'size', 'remote', 'blockmap'])(
    'refuses incomplete or corrupt publication: %s',
    (failure) => {
      const items = records()
      let assets = uploaded(items).map((asset) => ({ ...asset }))
      if (failure === 'missing') {
        items.pop()
      }
      if (failure === 'duplicate') {
        items[1] = record('arm64')
      }
      if (failure === 'version') {
        items[0].manifest.version = '1.0.0'
      }
      if (failure === 'path') {
        items[0].manifest.files[0].url = '../outside.zip'
      }
      if (failure === 'checksum') {
        items[0].manifest.files[0].sha512 = 'bad'
      }
      if (failure === 'size') {
        assets[0].size++
      }
      if (failure === 'remote') {
        assets.push({ ...assets[0] })
      }
      if (failure === 'blockmap') {
        assets = assets.filter((asset) => !asset.name.endsWith('.blockmap'))
      }
      expect(() => mergeManifests(items, version, assets)).toThrow()
    }
  )

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

  it('rejects extra manifest entries from the wrong architecture', () => {
    const item = record('x64')
    item.manifest.files.push(record('arm64').manifest.files[0])
    expect(() => validateManifest(item.manifest, 'x64', version)).toThrow()
  })
})
