import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { readAsarPackageVersion } from './asar-package-version'

let dir: string | null = null

afterEach(async () => {
  if (dir) {
    await rm(dir, { recursive: true, force: true })
    dir = null
  }
})

function buildAsar(files: Record<string, string>): Buffer {
  const blobs = Object.entries(files).map(([name, text]) => [name, Buffer.from(text)] as const)
  let offset = 0
  const entries: Record<string, { offset: string; size: number }> = {}
  for (const [name, blob] of blobs) {
    entries[name] = { offset: String(offset), size: blob.length }
    offset += blob.length
  }
  const json = Buffer.from(JSON.stringify({ files: entries }))
  const stringPickleSize = 4 + json.length
  const padded = Math.ceil(stringPickleSize / 4) * 4
  const headerPickleSize = 4 + padded
  const header = Buffer.alloc(8 + headerPickleSize)
  header.writeUInt32LE(4, 0)
  header.writeUInt32LE(headerPickleSize, 4)
  header.writeUInt32LE(padded, 8)
  header.writeUInt32LE(json.length, 12)
  json.copy(header, 16)
  return Buffer.concat([header, ...blobs.map(([, blob]) => blob)])
}

it('reads the version from the archive bytes, not from a cached header', async () => {
  dir = await mkdtemp(join(tmpdir(), 'orca-asar-version-'))
  const archive = join(dir, 'app.asar')
  await writeFile(archive, buildAsar({ 'package.json': '{"version":"1.4.255"}' }))
  expect(await readAsarPackageVersion(archive)).toBe('1.4.255')

  // Same path, new contents at new offsets: the file on disk decides, as after a package upgrade.
  await writeFile(
    archive,
    buildAsar({ LICENSE: 'x'.repeat(300), 'package.json': '{"name":"orca","version":"1.4.256"}' })
  )
  expect(await readAsarPackageVersion(archive)).toBe('1.4.256')
})

it('returns null for a missing archive or one without a readable package.json', async () => {
  dir = await mkdtemp(join(tmpdir(), 'orca-asar-version-'))
  expect(await readAsarPackageVersion(join(dir, 'absent.asar'))).toBeNull()
  const archive = join(dir, 'app.asar')
  await writeFile(archive, 'not an archive at all')
  expect(await readAsarPackageVersion(archive)).toBeNull()
})
