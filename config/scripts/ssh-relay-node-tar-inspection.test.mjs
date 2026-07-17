import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

import { create, Header } from 'tar'
import { afterEach, describe, expect, it } from 'vitest'

import { inspectSshRelayNodeTarStream } from './ssh-relay-node-tar-inspection.mjs'

const tuple = 'darwin-arm64'
const root = 'node-v24.18.0-darwin-arm64'
const archives = {
  'darwin-arm64': {
    name: `${root}.tar.xz`,
    sha256: '1'.repeat(64)
  },
  'darwin-x64': {
    name: 'node-v24.18.0-darwin-x64.tar.xz',
    sha256: '2'.repeat(64)
  },
  'linux-arm64-glibc': {
    name: 'node-v24.18.0-linux-arm64.tar.xz',
    sha256: '3'.repeat(64)
  },
  'linux-x64-glibc': {
    name: 'node-v24.18.0-linux-x64.tar.xz',
    sha256: '4'.repeat(64)
  },
  'win32-arm64': {
    name: 'node-v24.18.0-win-arm64.zip',
    sha256: '5'.repeat(64)
  },
  'win32-x64': {
    name: 'node-v24.18.0-win-x64.zip',
    sha256: '6'.repeat(64)
  }
}
const release = {
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
  archives,
  windowsBuildInputs: {
    headersArchive: { name: 'node-v24.18.0-headers.tar.gz', sha256: '7'.repeat(64) },
    importLibraries: {
      'win32-arm64': { name: 'win-arm64/node.lib', sha256: '8'.repeat(64) },
      'win32-x64': { name: 'win-x64/node.lib', sha256: '9'.repeat(64) }
    }
  }
}

const temporaryDirectories = []
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })))
})

async function validTarStream() {
  const directory = await mkdtemp(join(tmpdir(), 'orca-node-tar-test-'))
  temporaryDirectories.push(directory)
  await Promise.all([
    mkdir(join(directory, root, 'bin'), { recursive: true }),
    mkdir(join(directory, root, 'include', 'node'), { recursive: true })
  ])
  await Promise.all([
    writeFile(join(directory, root, 'bin', 'node'), 'node executable'),
    writeFile(join(directory, root, 'LICENSE'), 'Node license'),
    writeFile(join(directory, root, 'include', 'node', 'node.h'), 'Node header')
  ])
  return create(
    {
      cwd: directory,
      portable: true,
      // Why: NTFS cannot express POSIX execute bits, so the archive fixture must declare its mode.
      onWriteEntry: (entry) => {
        if (entry.path.replaceAll('\\', '/') === `${root}/bin/node` && entry.stat) {
          entry.stat.mode = (entry.stat.mode & ~0o777) | 0o755
        }
      }
    },
    [root]
  )
}

function rawTar(entries) {
  const blocks = []
  for (const entry of entries) {
    const block = Buffer.alloc(512)
    new Header({
      path: entry.path,
      linkpath: entry.linkpath,
      mode: entry.mode ?? 0o644,
      uid: 0,
      gid: 0,
      size: 0,
      mtime: new Date(0),
      type: entry.type ?? 'File',
      uname: '',
      gname: ''
    }).encode(block)
    blocks.push(block)
  }
  blocks.push(Buffer.alloc(1024))
  return Readable.from(blocks)
}

describe('SSH relay Node tar inspection', () => {
  it('accepts a bounded exact-root archive with executable Node and build inputs', async () => {
    await expect(
      inspectSshRelayNodeTarStream(await validTarStream(), release, tuple)
    ).resolves.toMatchObject({
      root,
      files: 3,
      expandedBytes: 38,
      nodeMode: 0o755
    })
  })

  it('rejects traversal, escaping links, special entries, and duplicates', async () => {
    await expect(
      inspectSshRelayNodeTarStream(rawTar([{ path: '../outside' }]), release, tuple)
    ).rejects.toThrow(/unsafe path segment/i)
    await expect(
      inspectSshRelayNodeTarStream(
        rawTar([{ path: `${root}/bin/npm`, type: 'SymbolicLink', linkpath: '../../outside' }]),
        release,
        tuple
      )
    ).rejects.toThrow(/outside its versioned root/i)
    await expect(
      inspectSshRelayNodeTarStream(
        rawTar([{ path: `${root}/device`, type: 'CharacterDevice' }]),
        release,
        tuple
      )
    ).rejects.toThrow(/prohibited entry type/i)
    await expect(
      inspectSshRelayNodeTarStream(
        rawTar([{ path: `${root}/LICENSE` }, { path: `${root}/LICENSE` }]),
        release,
        tuple
      )
    ).rejects.toThrow(/duplicate entry/i)
  })

  it('enforces entry and expanded-size limits while streaming', async () => {
    await expect(
      inspectSshRelayNodeTarStream(await validTarStream(), release, tuple, {
        maximumEntries: 2
      })
    ).rejects.toThrow(/entry-count limit/i)
    await expect(
      inspectSshRelayNodeTarStream(await validTarStream(), release, tuple, {
        maximumExpandedBytes: 8
      })
    ).rejects.toThrow(/expanded-size limit/i)
  })
})
