import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as FsPromises from 'node:fs/promises'
import { writePluginFileAtomically } from './plugin-atomic-file-write'

// Windows AV/indexer locks cannot be provoked on CI, so queue the errno codes instead.
const locks = vi.hoisted(() => ({ codes: [] as string[] }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>()
  return {
    ...actual,
    rename: async (source: string, target: string) => {
      const code = locks.codes.shift()
      if (!code) {
        return actual.rename(source, target)
      }
      throw Object.assign(new Error(`simulated ${code}`), { code })
    }
  }
})

function withPlatform(platform: string): () => void {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  return () => {
    if (original) {
      Object.defineProperty(process, 'platform', original)
    }
  }
}

describe('writePluginFileAtomically', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'orca-plugin-atomic-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('applies the requested mode', async () => {
    const target = join(dir, 'provenance.json')
    await writePluginFileAtomically(target, '{}', { mode: 0o600 })
    const mode = (await stat(target)).mode & 0o777
    // Windows does not model POSIX permission bits.
    if (process.platform !== 'win32') {
      expect(mode).toBe(0o600)
    }
  })

  it('cleans up the temp file when the rename gives up', async () => {
    const restorePlatform = withPlatform('win32')
    locks.codes = Array.from({ length: 6 }, () => 'EPERM')
    try {
      await expect(writePluginFileAtomically(join(dir, 'current'), 'v')).rejects.toMatchObject({
        code: 'EPERM'
      })
      expect(await readdir(dir)).toEqual([])
    } finally {
      restorePlatform()
      locks.codes = []
    }
  })

  it('runs concurrent writers to one target without leaking temp files', async () => {
    const target = join(dir, 'sources.json')
    await Promise.all(
      Array.from({ length: 8 }, (_unused, index) =>
        writePluginFileAtomically(target, `value-${index}`)
      )
    )
    expect(await readdir(dir)).toEqual(['sources.json'])
    expect(await readFile(target, 'utf8')).toMatch(/^value-\d$/)
  })
})
