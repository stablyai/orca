import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as FsPromises from 'node:fs/promises'
import {
  renamePluginFileWithWindowsRetry,
  writePluginFileAtomically
} from './plugin-atomic-file-write'

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

  it('writes contents and leaves no temp file behind', async () => {
    const target = join(dir, 'current')
    await writePluginFileAtomically(target, 'abc123')
    expect(await readFile(target, 'utf8')).toBe('abc123')
    expect(await readdir(dir)).toEqual(['current'])
  })

  it('replaces an existing file', async () => {
    const target = join(dir, 'plugins.lock.json')
    await writePluginFileAtomically(target, 'first')
    await writePluginFileAtomically(target, 'second')
    expect(await readFile(target, 'utf8')).toBe('second')
    expect(await readdir(dir)).toEqual(['plugins.lock.json'])
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

  it('cleans up the temp file when the write fails', async () => {
    await expect(writePluginFileAtomically(join(dir, 'missing', 'x'), 'v')).rejects.toThrow()
    expect(await readdir(dir)).toEqual([])
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

describe('renamePluginFileWithWindowsRetry', () => {
  it('renames when the source exists', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orca-plugin-rename-'))
    try {
      await writePluginFileAtomically(join(dir, 'from'), 'payload')
      await renamePluginFileWithWindowsRetry(join(dir, 'from'), join(dir, 'to'))
      expect(await readFile(join(dir, 'to'), 'utf8')).toBe('payload')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('rethrows a non-retryable error', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orca-plugin-rename-'))
    try {
      await expect(
        renamePluginFileWithWindowsRetry(join(dir, 'absent'), join(dir, 'to'))
      ).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  describe('on Windows', () => {
    let dir: string
    let restorePlatform: () => void

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'orca-plugin-rename-win-'))
      restorePlatform = withPlatform('win32')
    })

    afterEach(async () => {
      restorePlatform()
      locks.codes = []
      await rm(dir, { recursive: true, force: true })
    })

    it.each(['EPERM', 'EACCES', 'EBUSY'])('retries past a transient %s lock', async (code) => {
      await writePluginFileAtomically(join(dir, 'from'), 'payload')
      locks.codes = [code, code]
      await renamePluginFileWithWindowsRetry(join(dir, 'from'), join(dir, 'to'))
      expect(await readFile(join(dir, 'to'), 'utf8')).toBe('payload')
      expect(locks.codes).toEqual([])
    })

    it('gives up after the last delay rather than looping forever', async () => {
      await writePluginFileAtomically(join(dir, 'from'), 'payload')
      // One more lock than there are delays, so the loop must exit on the bound.
      locks.codes = Array.from({ length: 6 }, () => 'EBUSY')
      await expect(
        renamePluginFileWithWindowsRetry(join(dir, 'from'), join(dir, 'to'))
      ).rejects.toMatchObject({ code: 'EBUSY' })
      expect(locks.codes).toEqual([])
    })

    it('rethrows a non-retryable code without retrying', async () => {
      await writePluginFileAtomically(join(dir, 'from'), 'payload')
      locks.codes = ['ENOSPC', 'ENOSPC']
      await expect(
        renamePluginFileWithWindowsRetry(join(dir, 'from'), join(dir, 'to'))
      ).rejects.toMatchObject({ code: 'ENOSPC' })
      expect(locks.codes).toEqual(['ENOSPC'])
    })
  })

  it('does not retry off Windows', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orca-plugin-rename-posix-'))
    const restorePlatform = withPlatform('linux')
    try {
      await writePluginFileAtomically(join(dir, 'from'), 'payload')
      locks.codes = ['EPERM', 'EPERM']
      await expect(
        renamePluginFileWithWindowsRetry(join(dir, 'from'), join(dir, 'to'))
      ).rejects.toMatchObject({ code: 'EPERM' })
      expect(locks.codes).toEqual(['EPERM'])
    } finally {
      restorePlatform()
      locks.codes = []
      await rm(dir, { recursive: true, force: true })
    }
  })
})
