import { createWriteStream } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'

import { afterEach, describe, expect, it } from 'vitest'
import { create } from 'tar'
import yazl from 'yazl'

import {
  extractVerifiedSshRelayNodeZipBuildInputs,
  inspectSshRelayNodeZip
} from './ssh-relay-node-zip-inspection.mjs'
import { assertPortableSshRelayNodeHeaderPath } from './ssh-relay-node-headers-extraction.mjs'
import { sha256 } from './ssh-relay-node-release-contract.mjs'

const tuple = 'win32-x64'
const root = 'node-v24.18.0-win-x64'
const temporaryDirectories = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })))
})

function release(archiveSha256, headersSha256 = '7'.repeat(64), librarySha256 = '9'.repeat(64)) {
  return {
    schemaVersion: 1,
    nodeVersion: '24.18.0',
    baseUrl: 'https://nodejs.org/dist/v24.18.0',
    checksumDocument: {
      name: 'SHASUMS256.txt',
      sha256: 'a'.repeat(64),
      maximumBytes: 1024
    },
    signature: {
      name: 'SHASUMS256.txt.sig',
      sha256: 'b'.repeat(64),
      maximumBytes: 1024,
      signerFingerprint: 'C'.repeat(40),
      key: {
        path: 'release-key.asc',
        sha256: 'c'.repeat(64),
        sourceCommit: 'd'.repeat(40),
        sourceUrl:
          `https://raw.githubusercontent.com/nodejs/release-keys/${'d'.repeat(40)}` +
          `/keys/${'C'.repeat(40)}.asc`
      }
    },
    maximumArchiveBytes: 1024 * 1024,
    archives: {
      'darwin-arm64': { name: 'node-v24.18.0-darwin-arm64.tar.xz', sha256: '1'.repeat(64) },
      'darwin-x64': { name: 'node-v24.18.0-darwin-x64.tar.xz', sha256: '2'.repeat(64) },
      'linux-arm64-glibc': {
        name: 'node-v24.18.0-linux-arm64.tar.xz',
        sha256: '3'.repeat(64)
      },
      'linux-x64-glibc': {
        name: 'node-v24.18.0-linux-x64.tar.xz',
        sha256: '4'.repeat(64)
      },
      'win32-arm64': { name: 'node-v24.18.0-win-arm64.zip', sha256: '5'.repeat(64) },
      'win32-x64': { name: `${root}.zip`, sha256: archiveSha256 }
    },
    windowsBuildInputs: {
      headersArchive: { name: 'node-v24.18.0-headers.tar.gz', sha256: headersSha256 },
      importLibraries: {
        'win32-arm64': { name: 'win-arm64/node.lib', sha256: '8'.repeat(64) },
        'win32-x64': { name: 'win-x64/node.lib', sha256: librarySha256 }
      }
    }
  }
}

async function createZip(entries) {
  const directory = await mkdtemp(join(tmpdir(), 'orca-node-zip-test-'))
  temporaryDirectories.push(directory)
  const archivePath = join(directory, `${root}.zip`)
  const zip = new yazl.ZipFile()
  for (const entry of entries) {
    zip.addBuffer(Buffer.from(entry.bytes), entry.path, {
      mtime: new Date('2025-07-17T00:00:00.000Z'),
      mode: 0o644
    })
  }
  zip.end()
  await pipeline(zip.outputStream, createWriteStream(archivePath))
  return { archivePath, directory }
}

async function validZip(extraEntries = []) {
  return createZip([
    { path: `${root}/node.exe`, bytes: 'node executable' },
    { path: `${root}/LICENSE`, bytes: 'Node license' },
    ...extraEntries
  ])
}

async function windowsBuildInputs(directory) {
  const source = join(directory, 'headers-source')
  const headersRoot = join(source, 'node-v24.18.0', 'include', 'node')
  await mkdir(headersRoot, { recursive: true })
  await Promise.all([
    writeFile(join(headersRoot, 'node.h'), 'Node header'),
    writeFile(join(headersRoot, 'common.gypi'), 'common gyp'),
    writeFile(join(headersRoot, 'config.gypi'), 'config gyp')
  ])
  const headersArchivePath = join(directory, 'node-v24.18.0-headers.tar.gz')
  await create({ cwd: source, file: headersArchivePath, gzip: true, portable: true }, [
    'node-v24.18.0'
  ])
  const importLibraryPath = join(directory, 'node.lib')
  await writeFile(importLibraryPath, 'node import library')
  return { headersArchivePath, importLibraryPath }
}

describe('SSH relay Node Windows ZIP inspection', () => {
  it('rejects Windows-unsafe header paths before extraction', () => {
    expect(() => assertPortableSshRelayNodeHeaderPath('node-v24.18.0/include/node/CON')).toThrow(
      /unsafe path segment/i
    )
    expect(() =>
      assertPortableSshRelayNodeHeaderPath('node-v24.18.0/include/node/header.h:stream')
    ).toThrow(/unsafe path segment/i)
    expect(() =>
      assertPortableSshRelayNodeHeaderPath('node-v24.18.0/include/node/header.h ')
    ).toThrow(/unsafe path segment/i)
  })

  it('inspects and selectively extracts only executable, license, and build headers', async () => {
    const value = await validZip([{ path: `${root}/npm.cmd`, bytes: 'excluded' }])
    const bytes = await readFile(value.archivePath)
    const inputs = await windowsBuildInputs(value.directory)
    const contract = release(
      sha256(bytes),
      sha256(await readFile(inputs.headersArchivePath)),
      sha256(await readFile(inputs.importLibraryPath))
    )
    await expect(inspectSshRelayNodeZip(value.archivePath, contract, tuple)).resolves.toMatchObject(
      {
        root,
        files: 3,
        hasNodeExecutable: true,
        hasLicense: true
      }
    )

    const destination = join(value.directory, 'extracted')
    const extracted = await extractVerifiedSshRelayNodeZipBuildInputs(
      contract,
      tuple,
      value.archivePath,
      destination,
      inputs
    )
    expect(await readFile(extracted.nodePath, 'utf8')).toBe('node executable')
    expect(await readFile(join(extracted.extractedRoot, 'include', 'node', 'node.h'), 'utf8')).toBe(
      'Node header'
    )
    expect(await readFile(join(extracted.extractedRoot, 'Release', 'node.lib'), 'utf8')).toBe(
      'node import library'
    )
    await expect(readFile(join(extracted.extractedRoot, 'npm.cmd'))).rejects.toThrow()
  })

  it('rejects traversal, case-fold collisions, and bounded-size violations', async () => {
    const traversal = await validZip([{ path: `${root}/aa/outside`, bytes: 'bad' }])
    const safeName = Buffer.from(`${root}/aa/outside`)
    const unsafeName = Buffer.from(`${root}/../outside`)
    const traversalBytes = await readFile(traversal.archivePath)
    for (let offset = traversalBytes.indexOf(safeName); offset !== -1; ) {
      unsafeName.copy(traversalBytes, offset)
      offset = traversalBytes.indexOf(safeName, offset + unsafeName.length)
    }
    await writeFile(traversal.archivePath, traversalBytes)
    const traversalContract = release(sha256(await readFile(traversal.archivePath)))
    await expect(
      inspectSshRelayNodeZip(traversal.archivePath, traversalContract, tuple)
    ).rejects.toThrow(/unsafe path segment|invalid relative path/i)

    const collision = await validZip([{ path: `${root}/license`, bytes: 'duplicate spelling' }])
    const collisionContract = release(sha256(await readFile(collision.archivePath)))
    await expect(
      inspectSshRelayNodeZip(collision.archivePath, collisionContract, tuple)
    ).rejects.toThrow(/case-fold collision/i)

    const oversized = await validZip()
    const oversizedContract = release(sha256(await readFile(oversized.archivePath)))
    await expect(
      inspectSshRelayNodeZip(oversized.archivePath, oversizedContract, tuple, {
        maximumExpandedBytes: 8
      })
    ).rejects.toThrow(/expanded-size limit/i)
  })
})
