import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, open, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { checkInstalledRendererAssets } from './installed-renderer-asset-integrity'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function unpackedEntry(contents: string): Record<string, unknown> {
  const hash = createHash('sha256').update(contents).digest('hex')
  return {
    size: Buffer.byteLength(contents),
    unpacked: true,
    integrity: { algorithm: 'SHA256', hash, blockSize: 4194304, blocks: [hash] }
  }
}

// Mirrors the Chromium pickle framing that @electron/asar writes ahead of the JSON index.
function asarHeaderBytes(header: unknown): Buffer {
  const json = Buffer.from(JSON.stringify(header))
  const paddedJsonLength = Math.ceil(json.length / 4) * 4
  const headerPickle = Buffer.alloc(8 + paddedJsonLength)
  headerPickle.writeUInt32LE(4 + paddedJsonLength, 0)
  headerPickle.writeUInt32LE(json.length, 4)
  json.copy(headerPickle, 8)
  const sizePickle = Buffer.alloc(8)
  sizePickle.writeUInt32LE(4, 0)
  sizePickle.writeUInt32LE(headerPickle.length, 4)
  return Buffer.concat([sizePickle, headerPickle])
}

async function installFixture(
  shipped: Record<string, string>,
  onDisk: Record<string, string>
): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'orca-asar-integrity-'))
  roots.push(root)
  const files: Record<string, unknown> = {}
  for (const [name, contents] of Object.entries(shipped)) {
    files[name] = unpackedEntry(contents)
  }
  const archivePath = path.join(root, 'app.asar')
  await writeFile(
    archivePath,
    asarHeaderBytes({
      files: { out: { files: { renderer: { files: { assets: { files } } } } } }
    })
  )
  const assetsDir = path.join(`${archivePath}.unpacked`, 'out', 'renderer', 'assets')
  await mkdir(assetsDir, { recursive: true })
  for (const [name, contents] of Object.entries(onDisk)) {
    await writeFile(path.join(assetsDir, name), contents)
  }
  return archivePath
}

const openPlainFile = (archivePath: string) => open(archivePath, 'r')

describe('checkInstalledRendererAssets', () => {
  const shipped = {
    'StatusBar-B_QZQJBc.js': 'export{a as StatusBar};',
    'Settings-Bmx6-uq-.js': 'export{b as Settings};'
  }

  it('reports an intact install when every unpacked file matches its recorded hash', async () => {
    const archivePath = await installFixture(shipped, shipped)
    await expect(checkInstalledRendererAssets(archivePath, openPlainFile)).resolves.toEqual({
      status: 'intact'
    })
  })

  it('names chunks edited or deleted after install', async () => {
    const archivePath = await installFixture(shipped, {
      'StatusBar-B_QZQJBc.js': 'function f(){export const enterprisePlan=1}'
    })
    await expect(checkInstalledRendererAssets(archivePath, openPlainFile)).resolves.toEqual({
      status: 'modified',
      files: ['assets/StatusBar-B_QZQJBc.js', 'assets/Settings-Bmx6-uq-.js']
    })
  })

  it('stays silent when the archive index cannot be read', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'orca-asar-integrity-'))
    roots.push(root)
    const archivePath = path.join(root, 'app.asar')
    await writeFile(archivePath, Buffer.from([1, 2, 3]))
    await expect(checkInstalledRendererAssets(archivePath, openPlainFile)).resolves.toEqual({
      status: 'unavailable'
    })
  })
})
