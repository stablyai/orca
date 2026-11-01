import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import type * as NodeFs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  removeFileAtomicallyIfUnchanged,
  writeFileAtomically,
  writeFileAtomicallyIfUnchanged
} from './fs-utils'

const fsMock = vi.hoisted(() => ({ linkSync: vi.fn(), renameSync: vi.fn() }))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  fsMock.linkSync.mockImplementation(actual.linkSync)
  fsMock.renameSync.mockImplementation(actual.renameSync)
  return { ...actual, linkSync: fsMock.linkSync, renameSync: fsMock.renameSync }
})

const originalPlatform = process.platform

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform })
  vi.restoreAllMocks()
})

describe('writeFileAtomically', () => {
  let dir: string

  function setup(): string {
    dir = mkdtempSync(join(tmpdir(), 'orca-fs-utils-'))
    return dir
  }

  function cleanup(): void {
    if (dir) {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it('applies the mode option to the written file', () => {
    if (process.platform === 'win32') {
      return
    }

    setup()
    try {
      const target = join(dir, 'secret.json')
      writeFileAtomically(target, '{"token":"abc"}\n', { mode: 0o600 })

      const mode = statSync(target).mode & 0o777
      expect(mode).toBe(0o600)
    } finally {
      cleanup()
    }
  })

  it('replaces only the expected file generation', () => {
    setup()
    try {
      const target = join(dir, 'guarded.toml')
      writeFileSync(target, 'baseline')

      expect(writeFileAtomicallyIfUnchanged(target, 'baseline', 'next')).toBe(true)
      expect(readFileSync(target, 'utf-8')).toBe('next')

      writeFileSync(target, 'concurrent')
      expect(writeFileAtomicallyIfUnchanged(target, 'next', 'stale-write')).toBe(false)
      expect(readFileSync(target, 'utf-8')).toBe('concurrent')
    } finally {
      cleanup()
    }
  })

  it('validates the generation moved after a Windows rename retry', () => {
    setup()
    try {
      const target = join(dir, 'guarded.toml')
      writeFileSync(target, 'baseline')
      Object.defineProperty(process, 'platform', { value: 'win32' })
      fsMock.renameSync.mockClear()
      fsMock.renameSync.mockImplementationOnce(() => {
        writeFileSync(target, 'concurrent')
        throw Object.assign(new Error('busy'), { code: 'EBUSY' })
      })

      expect(writeFileAtomicallyIfUnchanged(target, 'baseline', 'stale-write')).toBe(false)
      expect(readFileSync(target, 'utf-8')).toBe('concurrent')
      expect(fsMock.renameSync).toHaveBeenCalledTimes(2)
    } finally {
      cleanup()
    }
  })

  it('preserves a replacement created before guarded publication', () => {
    setup()
    try {
      const target = join(dir, 'guarded.toml')
      writeFileSync(target, 'baseline')
      const rename = fsMock.renameSync.getMockImplementation()
      fsMock.renameSync.mockImplementationOnce((source: string, destination: string) => {
        rename!(source, destination)
        writeFileSync(target, 'concurrent')
      })

      expect(writeFileAtomicallyIfUnchanged(target, 'baseline', 'stale-write')).toBe(false)
      expect(readFileSync(target, 'utf-8')).toBe('concurrent')
    } finally {
      cleanup()
    }
  })

  it('recovers an interrupted guarded operation before retrying', () => {
    setup()
    try {
      const target = join(dir, 'guarded.toml')
      const held = `${target}.orca-guarded`
      writeFileSync(held, 'baseline')

      expect(writeFileAtomicallyIfUnchanged(target, 'baseline', 'next')).toBe(true)
      expect(readFileSync(target, 'utf-8')).toBe('next')
      expect(existsSync(held)).toBe(false)
    } finally {
      cleanup()
    }
  })

  it('fails before moving the target when hard-link publication is unsupported', () => {
    setup()
    try {
      const target = join(dir, 'guarded.toml')
      writeFileSync(target, 'baseline')
      fsMock.linkSync.mockImplementationOnce(() => {
        throw Object.assign(new Error('unsupported'), { code: 'ENOTSUP' })
      })

      expect(() => writeFileAtomicallyIfUnchanged(target, 'baseline', 'next')).toThrow(
        'unsupported'
      )
      expect(readFileSync(target, 'utf-8')).toBe('baseline')
      expect(existsSync(`${target}.orca-guarded`)).toBe(false)
    } finally {
      cleanup()
    }
  })

  it('removes only the expected file generation', () => {
    setup()
    try {
      const target = join(dir, 'guarded-auth.json')
      writeFileSync(target, 'baseline')

      expect(removeFileAtomicallyIfUnchanged(target, 'other')).toBe(false)
      expect(readFileSync(target, 'utf-8')).toBe('baseline')
      expect(removeFileAtomicallyIfUnchanged(target, 'baseline')).toBe(true)
      expect(existsSync(target)).toBe(false)
    } finally {
      cleanup()
    }
  })

  it('returns false when the target disappears during the removal probe', () => {
    setup()
    try {
      const target = join(dir, 'guarded-auth.json')
      writeFileSync(target, 'baseline')
      fsMock.linkSync.mockImplementationOnce(() => {
        rmSync(target)
        throw Object.assign(new Error('gone'), { code: 'ENOENT' })
      })

      expect(removeFileAtomicallyIfUnchanged(target, 'baseline')).toBe(false)
      expect(existsSync(`${target}.orca-guarded`)).toBe(false)
    } finally {
      cleanup()
    }
  })

  it('preserves a replacement created while the expected generation is quarantined', () => {
    setup()
    try {
      const target = join(dir, 'guarded-auth.json')
      writeFileSync(target, 'baseline')
      const rename = fsMock.renameSync.getMockImplementation()
      fsMock.renameSync.mockImplementationOnce((source: string, destination: string) => {
        rename!(source, destination)
        writeFileSync(target, 'concurrent')
      })

      expect(removeFileAtomicallyIfUnchanged(target, 'baseline')).toBe(false)
      expect(readFileSync(target, 'utf-8')).toBe('concurrent')
    } finally {
      cleanup()
    }
  })
})
