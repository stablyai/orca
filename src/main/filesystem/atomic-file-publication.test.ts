import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import type * as NodeFs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  removeFileAtomicallyIfUnchanged,
  writeFileAtomicallyIfUnchanged
} from './atomic-file-publication'

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

  it('keeps interrupted held bytes when a writer recreated the target meanwhile', () => {
    setup()
    try {
      const target = join(dir, 'config.toml')
      writeFileSync(`${target}.orca-guarded`, 'model = "o5"\n[profiles.work]\n')
      // A writer that found no file wrote only its own key.
      writeFileSync(target, 'approval = "never"\n')

      expect(writeFileAtomicallyIfUnchanged(target, 'approval = "never"\n', 'next')).toBe(true)
      expect(readFileSync(target, 'utf-8')).toBe('next')
      expect(
        readdirSync(dir)
          .filter((name) => name !== 'config.toml')
          .map((name) => readFileSync(join(dir, name), 'utf-8'))
      ).toEqual(['model = "o5"\n[profiles.work]\n'])
    } finally {
      cleanup()
    }
  })

  it('keeps one copy when the same conflict repeats', () => {
    setup()
    try {
      const target = join(dir, 'config.toml')
      for (const next of ['first', 'second']) {
        writeFileSync(`${target}.orca-guarded`, 'model = "o5"\n')
        writeFileSync(target, 'approval = "never"\n')
        expect(writeFileAtomicallyIfUnchanged(target, 'approval = "never"\n', next)).toBe(true)
      }
      expect(readdirSync(dir).filter((name) => name.includes('.orca-kept-'))).toHaveLength(1)
    } finally {
      cleanup()
    }
  })

  it('drops an interrupted held credential instead of keeping it beside a recreated target', () => {
    setup()
    try {
      const target = join(dir, 'auth.json')
      writeFileSync(`${target}.orca-guarded`, '{"token":"a"}')
      writeFileSync(target, '{"token":"b"}')

      expect(removeFileAtomicallyIfUnchanged(target, '{"token":"b"}', { credential: true })).toBe(
        true
      )
      expect(readdirSync(dir)).toEqual([])
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
