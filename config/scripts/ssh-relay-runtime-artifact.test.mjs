import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  createSshRelayRuntimeArchive,
  inspectSshRelayRuntimeArchive
} from './ssh-relay-runtime-archive.mjs'
import { computeSshRelayRuntimeContentId } from './ssh-relay-runtime-identity.mjs'
import {
  formatSshRelayRuntimeSmokeFailure,
  verifyRuntimeTree
} from './verify-ssh-relay-runtime.mjs'

const temporaryDirectories = []
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })))
})

const digest = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`

function canonicalFixture() {
  const d = (character) => `sha256:${character.repeat(64)}`
  return {
    tupleId: 'linux-x64-glibc',
    os: 'linux',
    architecture: 'x64',
    compatibility: {
      kind: 'linux',
      minimumKernelVersion: '4.18',
      libc: {
        family: 'glibc',
        minimumVersion: '2.28',
        minimumLibstdcxxVersion: '6.0.25',
        minimumGlibcxxVersion: '3.4.25'
      }
    },
    nodeVersion: '24.18.0',
    dependencies: { nodePtyVersion: '1.1.0', parcelWatcherVersion: '2.5.6' },
    entries: [
      { path: 'bin', type: 'directory', mode: 0o755 },
      { path: 'bin/node', type: 'file', role: 'node', size: 40, mode: 0o755, sha256: d('1') },
      { path: 'relay.js', type: 'file', role: 'relay', size: 20, mode: 0o644, sha256: d('2') },
      {
        path: 'relay-watcher.js',
        type: 'file',
        role: 'relay-watcher',
        size: 15,
        mode: 0o644,
        sha256: d('3')
      },
      { path: 'node_modules', type: 'directory', mode: 0o755 },
      { path: 'node_modules/node-pty', type: 'directory', mode: 0o755 },
      {
        path: 'node_modules/node-pty/package.json',
        type: 'file',
        role: 'runtime-javascript',
        size: 10,
        mode: 0o644,
        sha256: d('4')
      },
      { path: 'node_modules/node-pty/build', type: 'directory', mode: 0o755 },
      { path: 'node_modules/node-pty/build/Release', type: 'directory', mode: 0o755 },
      {
        path: 'node_modules/node-pty/build/Release/pty.node',
        type: 'file',
        role: 'node-pty-native',
        size: 30,
        mode: 0o755,
        sha256: d('5')
      },
      { path: 'node_modules/@parcel', type: 'directory', mode: 0o755 },
      { path: 'node_modules/@parcel/watcher', type: 'directory', mode: 0o755 },
      {
        path: 'node_modules/@parcel/watcher/package.json',
        type: 'file',
        role: 'runtime-javascript',
        size: 10,
        mode: 0o644,
        sha256: d('6')
      },
      {
        path: 'node_modules/@parcel/watcher-linux-x64-glibc',
        type: 'directory',
        mode: 0o755
      },
      {
        path: 'node_modules/@parcel/watcher-linux-x64-glibc/watcher.node',
        type: 'file',
        role: 'parcel-watcher-native',
        size: 25,
        mode: 0o755,
        sha256: d('7')
      },
      {
        path: 'THIRD_PARTY_LICENSES.txt',
        type: 'file',
        role: 'license',
        size: 10,
        mode: 0o644,
        sha256: d('8')
      }
    ]
  }
}

async function tinyRuntime() {
  const directory = await mkdtemp(join(tmpdir(), 'orca-runtime-artifact-test-'))
  temporaryDirectories.push(directory)
  const runtimeRoot = join(directory, 'runtime')
  await mkdir(join(runtimeRoot, 'bin'), { recursive: true })
  await Promise.all([
    writeFile(join(runtimeRoot, 'bin', 'node'), 'node'),
    writeFile(join(runtimeRoot, 'relay.js'), 'relay')
  ])
  await chmod(join(runtimeRoot, 'bin', 'node'), 0o755)
  const base = {
    tupleId: 'darwin-arm64',
    os: 'darwin',
    architecture: 'arm64',
    compatibility: { kind: 'darwin', minimumVersion: '13.5' },
    nodeVersion: '24.18.0',
    dependencies: { nodePtyVersion: '1.1.0', parcelWatcherVersion: '2.5.6' },
    entries: [
      { path: 'bin', type: 'directory', mode: 0o755 },
      {
        path: 'bin/node',
        type: 'file',
        role: 'node',
        size: 4,
        mode: 0o755,
        sha256: digest('node')
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
    expandedSize: 9
  }
  return {
    directory,
    runtimeRoot,
    identity: { ...base, contentId: computeSshRelayRuntimeContentId(base) }
  }
}

describe('SSH relay runtime artifact', () => {
  it('matches the reviewed TypeScript canonical content-identity vector', () => {
    expect(computeSshRelayRuntimeContentId(canonicalFixture())).toBe(
      'sha256:5afe9c8094ec61a5eec6f7be6d1035faacee7362871985c74cc6ee6aceea8677'
    )
  })

  it('requires the complete exact runtime tree before execution', async () => {
    const fixture = await tinyRuntime()
    await expect(verifyRuntimeTree(fixture.runtimeRoot, fixture.identity)).resolves.toMatchObject({
      entries: 3,
      files: 2,
      expandedBytes: 9
    })
    await writeFile(join(fixture.runtimeRoot, 'relay.js'), 'tampered')
    await expect(verifyRuntimeTree(fixture.runtimeRoot, fixture.identity)).rejects.toThrow(
      /integrity mismatch/i
    )

    await writeFile(join(fixture.runtimeRoot, 'relay.js'), 'relay')
    if (process.platform !== 'win32') {
      // Why: NTFS cannot represent the POSIX mode that the verified ZIP carries for remote install.
      await chmod(join(fixture.runtimeRoot, 'relay.js'), 0o600)
      await expect(verifyRuntimeTree(fixture.runtimeRoot, fixture.identity)).rejects.toThrow(
        /entry mismatch/i
      )
    }
  })

  it('preserves bounded bundled-smoke child failure diagnostics', () => {
    const message = formatSshRelayRuntimeSmokeFailure({
      code: 'ETIMEDOUT',
      killed: true,
      signal: 'SIGTERM',
      message: 'Command timed out',
      stdout: 'partial smoke output',
      stderr: `${'x'.repeat(70 * 1024)}Bundled runtime smoke failed: watcher create exceeded 15000 ms`
    })

    expect(message).toContain('timeoutMs=45000')
    expect(message).toContain('code="ETIMEDOUT"')
    expect(message).toContain('killed=true')
    expect(message).toContain('signal="SIGTERM"')
    expect(message).toContain('partial smoke output')
    expect(message).toContain('truncated')
    expect(message).toContain('watcher create exceeded 15000 ms')
  })

  it.skipIf(process.platform === 'win32')(
    'creates deterministic archives and rehashes every entry',
    async () => {
      const fixture = await tinyRuntime()
      const firstDirectory = join(fixture.directory, 'first')
      const secondDirectory = join(fixture.directory, 'second')
      await Promise.all([mkdir(firstDirectory), mkdir(secondDirectory)])
      const first = await createSshRelayRuntimeArchive({
        runtimeRoot: fixture.runtimeRoot,
        outputDirectory: firstDirectory,
        identity: fixture.identity,
        sourceDateEpoch: 1_752_710_400
      })
      const second = await createSshRelayRuntimeArchive({
        runtimeRoot: fixture.runtimeRoot,
        outputDirectory: secondDirectory,
        identity: fixture.identity,
        sourceDateEpoch: 1_752_710_400
      })

      expect(await readFile(first.path)).toEqual(await readFile(second.path))
      await expect(inspectSshRelayRuntimeArchive(first.path, fixture.identity)).resolves.toEqual({
        entries: 3,
        files: 2,
        expandedBytes: 9
      })
    }
  )
})
