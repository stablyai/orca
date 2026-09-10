import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as FsPromisesModule from 'node:fs/promises'

const statCalls = vi.hoisted(() => ({ inFlight: 0, peak: 0, total: 0 }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromisesModule>()
  return {
    ...actual,
    stat: async (...args: Parameters<typeof actual.stat>) => {
      statCalls.inFlight += 1
      statCalls.total += 1
      statCalls.peak = Math.max(statCalls.peak, statCalls.inFlight)
      try {
        return await actual.stat(...args)
      } finally {
        statCalls.inFlight -= 1
      }
    }
  }
})

const { readRelayDir } = await import('./fs-path-metadata-requests')

describe('relay readDir symlink probes', () => {
  let root: string
  let targetRoot: string

  beforeEach(() => {
    statCalls.inFlight = 0
    statCalls.peak = 0
    statCalls.total = 0
    root = mkdtempSync(join(tmpdir(), 'orca-relay-readdir-'))
    // Kept outside `root` so the listing contains only the symlinks under test.
    targetRoot = mkdtempSync(join(tmpdir(), 'orca-relay-readdir-target-'))
    const target = join(targetRoot, 'target')
    mkdirSync(target)
    writeFileSync(join(target, 'index.js'), '')
    // A pnpm-shaped node_modules: many package symlinks in one directory. Junctions on
    // Windows: plain symlinks need Developer Mode there.
    for (let index = 0; index < 60; index += 1) {
      symlinkSync(
        target,
        join(root, `pkg-${index}`),
        process.platform === 'win32' ? 'junction' : 'dir'
      )
    }
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
    rmSync(targetRoot, { recursive: true, force: true })
  })

  it('bounds concurrent symlink stats instead of issuing one per entry at once', async () => {
    const entries = await readRelayDir({ dirPath: root })

    expect(statCalls.total).toBe(60)
    // Exactly the cap: every worker enters `stat` before any resolves, so the peak proves the
    // probes overlap and that no more than 8 ever do. Unbounded, all 60 would be in flight,
    // saturating libuv's four-thread pool and stalling every other relay filesystem read.
    expect(statCalls.peak).toBe(8)
    // Behaviour is unchanged: every symlink still resolves to its target's kind.
    expect(entries).toHaveLength(60)
    expect(entries.every((entry) => entry.isDirectory && entry.isSymlink)).toBe(true)
  })
})
