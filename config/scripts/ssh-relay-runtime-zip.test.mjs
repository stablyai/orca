import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'

import { afterEach, describe, expect, it } from 'vitest'
import yazl from 'yazl'

import { computeSshRelayRuntimeContentId } from './ssh-relay-runtime-identity.mjs'
import { createSshRelayRuntimeZip, inspectSshRelayRuntimeZip } from './ssh-relay-runtime-zip.mjs'

const temporaryDirectories = []
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })))
})

const digest = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'orca-runtime-zip-test-'))
  temporaryDirectories.push(directory)
  const runtimeRoot = join(directory, 'runtime')
  await mkdir(join(runtimeRoot, 'bin'), { recursive: true })
  await Promise.all([
    writeFile(join(runtimeRoot, 'bin', 'node.exe'), 'node executable'),
    writeFile(join(runtimeRoot, 'relay.js'), 'relay')
  ])
  await chmod(join(runtimeRoot, 'bin', 'node.exe'), 0o755)
  const base = {
    tupleId: 'win32-x64',
    os: 'win32',
    architecture: 'x64',
    compatibility: {
      kind: 'windows',
      minimumBuild: 19045,
      minimumOpenSshVersion: '8.1p1',
      minimumPowerShellVersion: '5.1',
      minimumDotNetFrameworkRelease: 528040
    },
    nodeVersion: '24.18.0',
    dependencies: { nodePtyVersion: '1.1.0', parcelWatcherVersion: '2.5.6' },
    entries: [
      { path: 'bin', type: 'directory', mode: 0o755 },
      {
        path: 'bin/node.exe',
        type: 'file',
        role: 'node',
        size: 15,
        mode: 0o755,
        sha256: digest('node executable')
      },
      {
        path: 'relay.js',
        type: 'file',
        role: 'relay',
        size: 5,
        mode: 0o644,
        sha256: digest('relay')
      }
    ],
    fileCount: 2,
    expandedSize: 20
  }
  return {
    directory,
    runtimeRoot,
    identity: { ...base, contentId: computeSshRelayRuntimeContentId(base) }
  }
}

async function writeZip(path, entries) {
  const zip = new yazl.ZipFile()
  for (const entry of entries) {
    zip.addBuffer(Buffer.from(entry.bytes ?? ''), entry.path, {
      mtime: new Date('2025-07-17T00:00:00.000Z'),
      mode: entry.mode ?? 0o644
    })
  }
  zip.end()
  await pipeline(zip.outputStream, createWriteStream(path))
}

describe('SSH relay runtime Windows ZIP', () => {
  it('creates deterministic ZIP bytes and rehashes the complete declared tree', async () => {
    const value = await fixture()
    const firstDirectory = join(value.directory, 'first')
    const secondDirectory = join(value.directory, 'second')
    await Promise.all([mkdir(firstDirectory), mkdir(secondDirectory)])
    const first = await createSshRelayRuntimeZip({
      runtimeRoot: value.runtimeRoot,
      outputDirectory: firstDirectory,
      identity: value.identity,
      sourceDateEpoch: 1_752_710_400
    })
    const second = await createSshRelayRuntimeZip({
      runtimeRoot: value.runtimeRoot,
      outputDirectory: secondDirectory,
      identity: value.identity,
      sourceDateEpoch: 1_752_710_400
    })

    expect(first.name).toMatch(/\.zip$/)
    expect(await readFile(first.path)).toEqual(await readFile(second.path))
    await expect(inspectSshRelayRuntimeZip(first.path, value.identity)).resolves.toEqual({
      entries: 3,
      files: 2,
      expandedBytes: 20
    })
  })

  it('rejects undeclared entries and declared-file integrity mismatches', async () => {
    const value = await fixture()
    const extra = join(value.directory, 'extra.zip')
    const tampered = join(value.directory, 'tampered.zip')
    await writeZip(extra, [
      { path: 'bin/node.exe', bytes: 'node executable', mode: 0o755 },
      { path: 'relay.js', bytes: 'relay' },
      { path: 'extra.js', bytes: 'extra' }
    ])
    await writeZip(tampered, [
      { path: 'bin/node.exe', bytes: 'node executable', mode: 0o755 },
      { path: 'relay.js', bytes: 'wrong' }
    ])

    await expect(inspectSshRelayRuntimeZip(extra, value.identity)).rejects.toThrow(
      /extra or duplicate/i
    )
    await expect(inspectSshRelayRuntimeZip(tampered, value.identity)).rejects.toThrow(
      /integrity mismatch/i
    )
  })
})
