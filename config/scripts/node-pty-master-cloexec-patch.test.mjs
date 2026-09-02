import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  SKIP_MARKER_FILENAME,
  applyNodePtyMasterCloexecPatch,
  assertPatchedNodePtyMasterCloexecSource,
  patchNodePtyMasterCloexecSource,
  revertNodePtyMasterCloexecSource
} = require('../relay-assets/node-pty-1.1.0-master-cloexec-patch.cjs')

// Byte-exact src/unix/pty.cc from the npm tarball the relay installs. The patch is keyed by its
// sha256, so a fixture that drifted from what npm ships would make every assertion below vacuous.
const STOCK_SOURCE = readFileSync(
  resolve(import.meta.dirname, '__fixtures__', 'node-pty-1.1.0-unix-pty.cc'),
  'utf8'
)
const projectDir = resolve(import.meta.dirname, '..', '..')
const cleanupDirs = []

afterEach(() => {
  for (const dir of cleanupDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('SSH relay node-pty pty-master close-on-exec patch', () => {
  it('adds the forkpty close-on-exec call and reverts to the published bytes', () => {
    const fixture = writeRelayFixture()

    expect(patchNodePtyMasterCloexecSource(fixture.root)).toBe(true)
    const patched = readFileSync(fixture.sourcePath, 'utf8')
    expect(patched).toContain('pty_cloexec(int fd)')
    expect(patched).toContain('if (pty_cloexec(master) == -1)')
    expect(() => assertPatchedNodePtyMasterCloexecSource(fixture.root)).not.toThrow()

    expect(patchNodePtyMasterCloexecSource(fixture.root)).toBe(false)
    expect(readFileSync(fixture.sourcePath, 'utf8')).toBe(patched)

    expect(revertNodePtyMasterCloexecSource(fixture.root)).toBe(true)
    expect(readFileSync(fixture.sourcePath, 'utf8')).toBe(STOCK_SOURCE)
  })

  it('refuses a different node-pty version or an unrecognized source', () => {
    const wrongVersion = writeRelayFixture({ version: '1.2.0-beta.4' })
    expect(() => patchNodePtyMasterCloexecSource(wrongVersion.root)).toThrow('expected 1.1.0')

    const drifted = writeRelayFixture({
      source: `${STOCK_SOURCE}\n// drift\n`
    })
    expect(() => patchNodePtyMasterCloexecSource(drifted.root)).toThrow('unexpected node-pty')

    const tampered = writeRelayFixture()
    patchNodePtyMasterCloexecSource(tampered.root)
    writeFileSync(tampered.sourcePath, `${readFileSync(tampered.sourcePath, 'utf8')}\n// drift\n`)
    expect(() => assertPatchedNodePtyMasterCloexecSource(tampered.root)).toThrow('not installed')
  })

  it('keeps the rebuilt addon once a later child no longer inherits the master', () => {
    const fixture = writeRelayFixture()
    const calls = []

    const status = applyNodePtyMasterCloexecPatch(fixture.root, {
      platform: 'linux',
      rebuild: () => {
        calls.push('rebuild')
        writeBuild(fixture, 'patched-build')
      },
      verify: () => 'isolated'
    })

    expect(status).toBe('patched')
    expect(calls).toEqual(['rebuild'])
    expect(readFileSync(fixture.buildPath, 'utf8')).toBe('patched-build')
    expect(readFileSync(fixture.sourcePath, 'utf8')).not.toBe(STOCK_SOURCE)
    expect(existsSync(fixture.backupDir)).toBe(false)
    expect(existsSync(fixture.skipMarkerPath)).toBe(false)
  })

  it('keeps a rebuilt addon whose flag /proc could not confirm', () => {
    const fixture = writeRelayFixture()

    const status = applyNodePtyMasterCloexecPatch(fixture.root, {
      platform: 'linux',
      rebuild: () => writeBuild(fixture, 'patched-build'),
      verify: () => 'unverified'
    })

    expect(status).toBe('patched-unverified')
    expect(readFileSync(fixture.buildPath, 'utf8')).toBe('patched-build')
  })

  it('restores the working build when the compile fails, and never retries it', () => {
    const fixture = writeRelayFixture()
    const calls = []

    const failed = applyNodePtyMasterCloexecPatch(fixture.root, {
      platform: 'linux',
      rebuild: () => {
        calls.push('rebuild')
        throw new Error('npm rebuild node-pty exited 1: no C++ toolchain')
      },
      verify: () => 'isolated'
    })

    expect(failed).toContain('failed:')
    expect(failed).toContain('no C++ toolchain')
    expect(readFileSync(fixture.buildPath, 'utf8')).toBe('stock-build')
    expect(readFileSync(fixture.sourcePath, 'utf8')).toBe(STOCK_SOURCE)
    expect(existsSync(fixture.backupDir)).toBe(false)
    expect(existsSync(fixture.skipMarkerPath)).toBe(true)

    // Bounded, not backed off: a relay directory gets one compile attempt, ever.
    const again = applyNodePtyMasterCloexecPatch(fixture.root, {
      platform: 'linux',
      rebuild: () => calls.push('rebuild'),
      verify: () => 'isolated'
    })
    expect(again).toBe('skipped:earlier-attempt-failed')
    expect(calls).toEqual(['rebuild'])
  })

  it('restores the working build when the rebuilt addon still leaks the master', () => {
    const fixture = writeRelayFixture()

    const status = applyNodePtyMasterCloexecPatch(fixture.root, {
      platform: 'linux',
      rebuild: () => writeBuild(fixture, 'still-leaky-build'),
      verify: () => {
        throw new Error('rebuilt node-pty still leaks the pty master into later children')
      }
    })

    expect(status).toContain('still leaks')
    expect(readFileSync(fixture.buildPath, 'utf8')).toBe('stock-build')
    expect(readFileSync(fixture.sourcePath, 'utf8')).toBe(STOCK_SOURCE)
  })

  it('never compiles on a platform that does not leak', () => {
    for (const platform of ['darwin', 'win32']) {
      const fixture = writeRelayFixture()
      const calls = []
      const status = applyNodePtyMasterCloexecPatch(fixture.root, {
        platform,
        rebuild: () => calls.push('rebuild'),
        verify: () => 'isolated'
      })
      expect(status).toBe('skipped:not-linux')
      expect(calls).toEqual([])
      expect(readFileSync(fixture.sourcePath, 'utf8')).toBe(STOCK_SOURCE)
    }
  })

  it('leaves an already patched install alone', () => {
    const fixture = writeRelayFixture()
    patchNodePtyMasterCloexecSource(fixture.root)
    const calls = []

    const status = applyNodePtyMasterCloexecPatch(fixture.root, {
      platform: 'linux',
      rebuild: () => calls.push('rebuild'),
      verify: () => 'isolated'
    })

    expect(status).toBe('already-patched')
    expect(calls).toEqual([])
  })

  it('will not rebuild an install that has no compiled addon to fall back on', () => {
    const fixture = writeRelayFixture({ build: false })
    const calls = []

    const status = applyNodePtyMasterCloexecPatch(fixture.root, {
      platform: 'linux',
      rebuild: () => calls.push('rebuild'),
      verify: () => 'isolated'
    })

    expect(status).toBe('skipped:no-compiled-build')
    expect(calls).toEqual([])
    expect(readFileSync(fixture.sourcePath, 'utf8')).toBe(STOCK_SOURCE)
  })

  it('discards a backup stranded by an interrupted rebuild', () => {
    const fixture = writeRelayFixture()
    mkdirSync(fixture.backupDir, { recursive: true })
    writeFileSync(join(fixture.backupDir, 'pty.node'), 'stranded-build')

    const status = applyNodePtyMasterCloexecPatch(fixture.root, {
      platform: 'linux',
      rebuild: () => writeBuild(fixture, 'patched-build'),
      verify: () => 'isolated'
    })

    expect(status).toBe('patched')
    expect(existsSync(fixture.backupDir)).toBe(false)
    expect(readFileSync(fixture.buildPath, 'utf8')).toBe('patched-build')
  })
})

function writeRelayFixture({ version = '1.1.0', source = STOCK_SOURCE, build = true } = {}) {
  const root = mkdtempSync(join(projectDir, '.node-pty-cloexec-patch-test-'))
  cleanupDirs.push(root)
  const nodePtyDir = join(root, 'node_modules', 'node-pty')
  const sourcePath = join(nodePtyDir, 'src', 'unix', 'pty.cc')
  const buildPath = join(nodePtyDir, 'build', 'Release', 'pty.node')
  mkdirSync(join(nodePtyDir, 'src', 'unix'), { recursive: true })
  writeFileSync(join(nodePtyDir, 'package.json'), JSON.stringify({ version }))
  writeFileSync(sourcePath, source)
  const fixture = {
    root,
    sourcePath,
    buildPath,
    backupDir: join(nodePtyDir, '.orca-cloexec-prepatch-release'),
    skipMarkerPath: join(root, SKIP_MARKER_FILENAME)
  }
  if (build) {
    writeBuild(fixture, 'stock-build')
  }
  return fixture
}

function writeBuild(fixture, contents) {
  mkdirSync(resolve(fixture.buildPath, '..'), { recursive: true })
  writeFileSync(fixture.buildPath, contents)
}
