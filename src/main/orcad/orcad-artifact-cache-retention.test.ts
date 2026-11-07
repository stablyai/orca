import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ORCAD_LOCK_FILE_NAME } from './orcad-instance-lock'
import {
  pruneDesktopOrcadArtifactCache,
  pruneOrcadArtifactCache
} from './orcad-artifact-cache-retention'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function cacheRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'orcad-artifact-cache-'))
  roots.push(root)
  return root
}

/** A real slot version name; `n` distinguishes builds. */
function version(n: number): string {
  return `0.1.0+${n.toString(16).padStart(12, '0')}`
}

function slot(root: string, target: string, name: string, ageMinutes: number): string {
  const path = join(root, target, name)
  mkdirSync(path, { recursive: true })
  writeFileSync(join(path, 'orcad.js'), '')
  const at = new Date(Date.now() - ageMinutes * 60_000)
  utimesSync(path, at, at)
  return path
}

describe('orcad artifact cache retention', () => {
  it('keeps the three most recently used slots per target and evicts older ones', async () => {
    const root = cacheRoot()
    const kept = [1, 2, 3].map((age) => slot(root, 'linux-x64-glibc', version(age), age))
    const evicted = [4, 5].map((age) => slot(root, 'linux-x64-glibc', version(age), age))
    const otherTarget = slot(root, 'darwin-arm64', version(9), 9)

    expect((await pruneOrcadArtifactCache(root)).sort()).toEqual(evicted.sort())
    for (const path of [...kept, otherTarget]) {
      expect(existsSync(path)).toBe(true)
    }
    for (const path of evicted) {
      expect(existsSync(path)).toBe(false)
    }
  })

  it('evicts only version slots, never the shared node runtime or other siblings (#38181)', async () => {
    const root = cacheRoot()
    const target = 'linux-x64-glibc'
    const nodeBinary = join(root, target, 'runtimes', 'node-abc123', 'bin', 'node')
    mkdirSync(join(root, target, 'runtimes', 'node-abc123', 'bin'), { recursive: true })
    writeFileSync(nodeBinary, '')
    // The shared runtime is older than every slot, which is exactly when it was evicted.
    slot(root, target, 'runtimes', 24 * 60)
    const sibling = slot(root, target, 'future-shared-cache', 24 * 60)
    const kept = [1, 2, 3].map((age) => slot(root, target, version(age), age))
    const evicted = [4, 5].map((age) => slot(root, target, version(age), age))

    const removed = await pruneOrcadArtifactCache(root)

    expect(removed.sort()).toEqual(evicted.sort())
    expect(existsSync(nodeBinary)).toBe(true)
    for (const path of [...kept, sibling]) {
      expect(existsSync(path)).toBe(true)
    }
  })

  it('keeps an in-use version (even a repair copy) plus the two most recent others', async () => {
    const root = cacheRoot()
    const recent = [1, 2].map((age) => slot(root, 'linux-x64-glibc', version(age), age))
    const third = slot(root, 'linux-x64-glibc', version(3), 3)
    const inUse = slot(root, 'linux-x64-glibc', `${version(50)}.repair-1`, 50)
    const staging = slot(root, 'linux-x64-glibc', '.staging-1-abc', 60)

    expect(await pruneOrcadArtifactCache(root, { inUseVersions: new Set([version(50)]) })).toEqual([
      third
    ])
    for (const path of [...recent, inUse, staging]) {
      expect(existsSync(path)).toBe(true)
    }
  })

  it('keeps both the selected slot and the one a running orcad serve still uses', async () => {
    const userData = cacheRoot()
    const root = join(userData, 'orcad-artifacts')
    const running = slot(root, 'linux-x64-glibc', version(90), 90)
    const selected = slot(root, 'linux-x64-glibc', version(0), 1)
    const others = [2, 3, 4].map((age) => slot(root, 'linux-x64-glibc', version(age), age))
    writeFileSync(
      join(userData, ORCAD_LOCK_FILE_NAME),
      JSON.stringify({
        pid: process.pid,
        startedAtMs: null,
        nonce: 'nonce',
        identity: 'uid',
        version: version(90),
        acquiredAt: new Date().toISOString(),
        role: 'orcad'
      })
    )
    expect(await pruneDesktopOrcadArtifactCache(userData, [version(0)])).toEqual([others[2]])
    expect(existsSync(running)).toBe(true)
    expect(existsSync(selected)).toBe(true)
  })

  it('keeps the slot a surviving terminal daemon runs from after orcad exits', async () => {
    const userData = cacheRoot()
    const root = join(userData, 'orcad-artifacts')
    const daemonSlot = slot(root, 'linux-x64-glibc', version(90), 90)
    const others = [1, 2, 3, 4].map((age) => slot(root, 'linux-x64-glibc', version(age), age))
    mkdirSync(join(userData, 'daemon'))
    writeFileSync(
      join(userData, 'daemon', 'daemon-v30.pid'),
      JSON.stringify({ pid: process.pid, entryPath: join(daemonSlot, 'out', 'daemon-entry.js') })
    )
    expect((await pruneDesktopOrcadArtifactCache(userData)).sort()).toEqual(
      [others[2], others[3]].sort()
    )
    expect(existsSync(daemonSlot)).toBe(true)
  })

  it('evicts nothing while a daemon record cannot be read', async () => {
    const userData = cacheRoot()
    const root = join(userData, 'orcad-artifacts')
    for (const age of [1, 2, 3, 4, 5]) {
      slot(root, 'linux-x64-glibc', version(age), age)
    }
    mkdirSync(join(userData, 'daemon'))
    writeFileSync(join(userData, 'daemon', 'daemon-v30.pid'), '')
    expect(await pruneDesktopOrcadArtifactCache(userData)).toEqual([])
  })
})
