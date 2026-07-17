import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { createSshRelayRuntimeArchive } from './ssh-relay-runtime-archive.mjs'
import { extractSshRelayRuntimeArchive } from './ssh-relay-runtime-archive-extraction.mjs'
import { expectedSshRelayRuntimeClosureEntries } from './ssh-relay-runtime-closure.mjs'
import { sshRelayRuntimeCompatibility } from './ssh-relay-runtime-compatibility.mjs'
import { computeSshRelayRuntimeContentId } from './ssh-relay-runtime-identity.mjs'

const temporaryDirectories = []
const SOURCE_DATE_EPOCH = 1_788_739_200

function sha256(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

async function fixture(tupleId) {
  const root = await mkdtemp(join(tmpdir(), 'ssh-relay-runtime-extraction-'))
  temporaryDirectories.push(root)
  const runtimeRoot = join(root, 'source-runtime')
  const archiveRoot = join(root, 'archive')
  await Promise.all([mkdir(runtimeRoot), mkdir(archiveRoot)])
  const entries = []
  for (const entry of expectedSshRelayRuntimeClosureEntries(tupleId)) {
    const path = join(runtimeRoot, ...entry.path.split('/'))
    if (entry.type === 'directory') {
      await mkdir(path, { recursive: true, mode: entry.mode })
      entries.push(entry)
      continue
    }
    const bytes = Buffer.from(`runtime extraction fixture:${tupleId}:${entry.path}`)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, bytes, { mode: entry.mode })
    entries.push({ ...entry, size: bytes.length, sha256: sha256(bytes) })
  }
  const os = tupleId.startsWith('win32-') ? 'win32' : 'darwin'
  const base = {
    identitySchemaVersion: 1,
    tupleId,
    os,
    architecture: tupleId.includes('arm64') ? 'arm64' : 'x64',
    compatibility: sshRelayRuntimeCompatibility[tupleId],
    nodeVersion: '24.18.0',
    dependencies: { nodePtyVersion: '1.1.0', parcelWatcherVersion: '2.5.6' },
    entries
  }
  const files = entries.filter((entry) => entry.type === 'file')
  const identity = {
    ...base,
    contentId: computeSshRelayRuntimeContentId(base),
    fileCount: files.length,
    expandedSize: files.reduce((total, entry) => total + entry.size, 0)
  }
  const archive = await createSshRelayRuntimeArchive({
    runtimeRoot,
    outputDirectory: archiveRoot,
    identity,
    sourceDateEpoch: SOURCE_DATE_EPOCH
  })
  return {
    root,
    runtimeRoot,
    archive,
    identity: {
      ...identity,
      archive: {
        name: archive.name,
        size: archive.size,
        expandedSize: identity.expandedSize,
        fileCount: identity.fileCount,
        sha256: archive.sha256
      }
    }
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

describe('SSH relay runtime archive extraction', () => {
  it('prepares a fresh staging parent while keeping the output leaf exclusive', async () => {
    const tupleId = process.platform === 'win32' ? `win32-${process.arch}` : 'darwin-arm64'
    const value = await fixture(tupleId)
    const outputDirectory = join(value.root, 'fresh-parent', 'reconstructed')

    const result = await extractSshRelayRuntimeArchive({
      archivePath: value.archive.path,
      outputDirectory,
      identity: value.identity
    })
    expect(result.runtimeRoot).toBe(await realpath(outputDirectory))

    await expect(
      extractSshRelayRuntimeArchive({
        archivePath: value.archive.path,
        outputDirectory,
        identity: value.identity
      })
    ).rejects.toThrow(/exclusive/i)
  })

  it('reconstructs exact POSIX and Windows runtime trees into exclusive directories', async () => {
    // Why: NTFS cannot materialize the executable modes needed to construct a POSIX tar fixture.
    const tuples =
      process.platform === 'win32' ? [`win32-${process.arch}`] : ['darwin-arm64', 'win32-x64']
    for (const tupleId of tuples) {
      const value = await fixture(tupleId)
      const outputDirectory = join(value.root, 'reconstructed')
      const result = await extractSshRelayRuntimeArchive({
        archivePath: value.archive.path,
        outputDirectory,
        identity: value.identity
      })

      expect(result.tupleId).toBe(tupleId)
      expect(result.tree.contentId).toBe(value.identity.contentId)
      expect(await readFile(join(outputDirectory, 'relay.js'))).toEqual(
        await readFile(join(value.runtimeRoot, 'relay.js'))
      )
    }
  })

  it('rejects modified archives and existing outputs without retaining partial trees', async () => {
    const modifiedTuple = process.platform === 'win32' ? `win32-${process.arch}` : 'darwin-x64'
    const modified = await fixture(modifiedTuple)
    await writeFile(modified.archive.path, 'not the authenticated archive')
    const rejectedOutput = join(modified.root, 'rejected')
    await expect(
      extractSshRelayRuntimeArchive({
        archivePath: modified.archive.path,
        outputDirectory: rejectedOutput,
        identity: modified.identity
      })
    ).rejects.toThrow(/size|digest|archive/i)
    await expect(readFile(join(rejectedOutput, 'relay.js'))).rejects.toMatchObject({
      code: 'ENOENT'
    })

    const existing = await fixture('win32-x64')
    const existingOutput = join(existing.root, 'existing')
    await mkdir(existingOutput)
    await expect(
      extractSshRelayRuntimeArchive({
        archivePath: existing.archive.path,
        outputDirectory: existingOutput,
        identity: existing.identity
      })
    ).rejects.toThrow(/exclusive/i)
  })
})
