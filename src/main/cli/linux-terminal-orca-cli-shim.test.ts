import { chmodSync, mkdirSync, readFileSync, statSync, truncateSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { isPackaged: true }
}))

import {
  _getLinuxTerminalShimCacheSizeForTests,
  _isLinuxTerminalShimCacheKeyRetainableForTests,
  _resetLinuxTerminalShimCacheForTests,
  ensureLinuxTerminalOrcaCliShimDir,
  LINUX_TERMINAL_SHIM_CACHE_KEY_MAX_BYTES,
  LINUX_TERMINAL_SHIM_CACHE_MAX_ENTRIES
} from './linux-terminal-orca-cli-shim'

const created: string[] = []

async function makeFixture(): Promise<{ userDataPath: string; resourcesPath: string }> {
  const root = await mkdtemp(join(tmpdir(), 'orca-terminal-cli-shim-'))
  created.push(root)
  const resourcesPath = join(root, 'resources')
  // The bundled orca-ide launcher must exist for the shim to be written.
  mkdirSync(join(resourcesPath, 'bin'), { recursive: true })
  writeFileSync(join(resourcesPath, 'bin', 'orca-ide'), '#!/usr/bin/env bash\n', 'utf8')
  return { userDataPath: join(root, 'user-data'), resourcesPath }
}

afterEach(async () => {
  _resetLinuxTerminalShimCacheForTests()
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('ensureLinuxTerminalOrcaCliShimDir', () => {
  it('writes an executable bare-orca shim that execs the bundled orca-ide launcher', async () => {
    const { userDataPath, resourcesPath } = await makeFixture()

    const shimDir = ensureLinuxTerminalOrcaCliShimDir({
      userDataPath,
      resourcesPath,
      appImagePath: null
    })

    expect(shimDir).toBe(join(userDataPath, 'linux-orca-cli-shim'))
    const content = readFileSync(join(shimDir!, 'orca'), 'utf8')
    // Single-quoted so a resources path with shell metacharacters can't break out.
    expect(content).toContain(`exec '${join(resourcesPath, 'bin', 'orca-ide')}' "$@"`)
    const mode = statSync(join(shimDir!, 'orca')).mode & 0o777
    expect(mode & 0o111).not.toBe(0)
  })

  it('memoizes per userDataPath and re-asserts the exec bit for a stale shim', async () => {
    const { userDataPath, resourcesPath } = await makeFixture()
    const options = { userDataPath, resourcesPath, appImagePath: null }

    const first = ensureLinuxTerminalOrcaCliShimDir(options)
    expect(first).not.toBeNull()
    const shimPath = join(first!, 'orca')
    chmodSync(shimPath, 0o644)

    // A distinct userData path is not memoized, so ensure runs again and heals
    // the exec bit lost above only when it actually processes that path.
    const second = ensureLinuxTerminalOrcaCliShimDir(options)
    expect(second).toBe(first)

    const root = await mkdtemp(join(tmpdir(), 'orca-terminal-cli-shim-2-'))
    created.push(root)
    const otherUserData = join(root, 'user-data')
    mkdirSync(join(otherUserData, 'linux-orca-cli-shim'), { recursive: true })
    writeFileSync(join(otherUserData, 'linux-orca-cli-shim', 'orca'), 'stale contents', 'utf8')
    chmodSync(join(otherUserData, 'linux-orca-cli-shim', 'orca'), 0o644)

    const healed = ensureLinuxTerminalOrcaCliShimDir({
      userDataPath: otherUserData,
      resourcesPath,
      appImagePath: null
    })
    expect(healed).not.toBeNull()
    const healedPath = join(healed!, 'orca')
    expect(readFileSync(healedPath, 'utf8')).toContain('orca-ide')
    expect(statSync(healedPath).mode & 0o111).not.toBe(0)
  })

  it('execs the stable AppImage (not the ephemeral mount) when running from an AppImage', async () => {
    const { userDataPath, resourcesPath } = await makeFixture()
    const appImagePath = join(userDataPath, 'Applications', 'Orca.AppImage')

    const shimDir = ensureLinuxTerminalOrcaCliShimDir({
      userDataPath,
      resourcesPath,
      appImagePath
    })

    const content = readFileSync(join(shimDir!, 'orca'), 'utf8')
    expect(content).toContain(appImagePath)
    expect(content).not.toContain(resourcesPath)
  })

  it('replaces a large sparse file at the owned shim path without loading it whole', async () => {
    const { userDataPath, resourcesPath } = await makeFixture()
    const shimDir = join(userDataPath, 'linux-orca-cli-shim')
    const shimPath = join(shimDir, 'orca')
    mkdirSync(shimDir, { recursive: true })
    writeFileSync(shimPath, 'stale')
    truncateSync(shimPath, 256 * 1024 * 1024)

    expect(
      ensureLinuxTerminalOrcaCliShimDir({
        userDataPath,
        resourcesPath,
        appImagePath: null
      })
    ).toBe(shimDir)
    expect(statSync(shimPath).size).toBeLessThan(64 * 1024)
    expect(readFileSync(shimPath, 'utf8')).toContain('orca-ide')
  })

  it('returns null (and does not memoize) when the bundled launcher is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-terminal-cli-shim-missing-'))
    created.push(root)
    const userDataPath = join(root, 'user-data')

    const missing = ensureLinuxTerminalOrcaCliShimDir({
      userDataPath,
      resourcesPath: join(root, 'resources'),
      appImagePath: null
    })
    expect(missing).toBeNull()

    // Once the launcher exists (e.g. later probe with real resources), the same
    // userData path succeeds — proving failures are not cached.
    const resourcesPath = join(root, 'resources')
    mkdirSync(join(resourcesPath, 'bin'), { recursive: true })
    writeFileSync(join(resourcesPath, 'bin', 'orca-ide'), '#!/usr/bin/env bash\n', 'utf8')
    const recovered = ensureLinuxTerminalOrcaCliShimDir({
      userDataPath,
      resourcesPath,
      appImagePath: null
    })
    expect(recovered).toBe(join(userDataPath, 'linux-orca-cli-shim'))
  })

  it('bounds successful user-data path memoization', async () => {
    const { userDataPath, resourcesPath } = await makeFixture()
    for (let index = 0; index <= LINUX_TERMINAL_SHIM_CACHE_MAX_ENTRIES; index += 1) {
      expect(
        ensureLinuxTerminalOrcaCliShimDir({
          userDataPath: join(userDataPath, String(index)),
          resourcesPath,
          appImagePath: null
        })
      ).not.toBeNull()
    }
    expect(_getLinuxTerminalShimCacheSizeForTests()).toBe(LINUX_TERMINAL_SHIM_CACHE_MAX_ENTRIES)
  })

  it('measures memoized paths by UTF-8 bytes', () => {
    expect(
      _isLinuxTerminalShimCacheKeyRetainableForTests(
        'x'.repeat(LINUX_TERMINAL_SHIM_CACHE_KEY_MAX_BYTES)
      )
    ).toBe(true)
    expect(
      _isLinuxTerminalShimCacheKeyRetainableForTests(
        '😀'.repeat(LINUX_TERMINAL_SHIM_CACHE_KEY_MAX_BYTES / 4 + 1)
      )
    ).toBe(false)
  })
})
