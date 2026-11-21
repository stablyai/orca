import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import type * as NodeFs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  recoverInterruptedGuardedFileOperation,
  removeFileAtomicallyIfUnchanged,
  writeFileAtomicallyIfUnchanged
} from './atomic-file-publication'

const fsMock = vi.hoisted(() => ({ linkSync: vi.fn(), renameSync: vi.fn(), rmSync: vi.fn() }))

type PathMock = typeof fsMock.linkSync

/** Runs `once` instead of the first call whose destination matches; returns the undo. */
function onFirstCallTo(
  mock: PathMock,
  matches: (destination: string) => boolean,
  once: (source: string, destination: string) => void
): () => void {
  const actual = mock.getMockImplementation()!
  let done = false
  mock.mockImplementation((source: string, destination: string) => {
    if (!done && matches(destination)) {
      done = true
      return once(source, destination)
    }
    return actual(source, destination)
  })
  return () => mock.mockImplementation(actual)
}

const isKept = (destination: string): boolean => destination.includes('.orca-kept-')
const isHeld = (destination: string): boolean => destination.endsWith('.orca-guarded')

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  fsMock.linkSync.mockImplementation(actual.linkSync)
  fsMock.renameSync.mockImplementation(actual.renameSync)
  fsMock.rmSync.mockImplementation(actual.rmSync)
  return {
    ...actual,
    linkSync: fsMock.linkSync,
    renameSync: fsMock.renameSync,
    rmSync: fsMock.rmSync
  }
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
      const undo = onFirstCallTo(fsMock.renameSync, isHeld, () => {
        writeFileSync(target, 'concurrent')
        throw Object.assign(new Error('busy'), { code: 'EBUSY' })
      })

      expect(writeFileAtomicallyIfUnchanged(target, 'baseline', 'stale-write')).toBe(false)
      undo()
      expect(readFileSync(target, 'utf-8')).toBe('concurrent')
    } finally {
      cleanup()
    }
  })

  it('preserves a replacement created before guarded publication', () => {
    setup()
    try {
      const target = join(dir, 'guarded.toml')
      writeFileSync(target, 'baseline')
      const rename = fsMock.renameSync.getMockImplementation()!
      const undo = onFirstCallTo(fsMock.renameSync, isHeld, (source, destination) => {
        rename(source, destination)
        writeFileSync(target, 'concurrent')
      })

      expect(writeFileAtomicallyIfUnchanged(target, 'baseline', 'stale-write')).toBe(false)
      undo()
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
      const conflict = (): void => {
        writeFileSync(`${target}.orca-guarded`, 'model = "o5"\n')
        writeFileSync(target, 'approval = "never"\n')
        expect(writeFileAtomicallyIfUnchanged(target, 'approval = "never"\n', 'next')).toBe(true)
      }
      const kept = (): string[] =>
        readdirSync(dir)
          .filter((name) => name.includes('.orca-kept-'))
          .map((name) => readFileSync(join(dir, name), 'utf-8'))
          .sort()
      conflict()
      conflict()
      expect(kept()).toEqual(['model = "o5"\n'])
      // Edited since it was kept, the copy no longer holds those bytes.
      const keptName = readdirSync(dir).find((name) => name.includes('.orca-kept-'))!
      writeFileSync(join(dir, keptName), 'model = "edited"\n')
      conflict()
      conflict()
      expect(kept()).toEqual(['model = "edited"\n', 'model = "o5"\n'])
    } finally {
      cleanup()
    }
  })

  it('gives the held file back when it cannot be kept aside', () => {
    setup()
    try {
      const target = join(dir, 'config.toml')
      writeFileSync(`${target}.orca-guarded`, 'model = "o5"\n')
      writeFileSync(target, 'approval = "never"\n')
      const undo = onFirstCallTo(fsMock.linkSync, isKept, () => {
        throw Object.assign(new Error('no space'), { code: 'ENOSPC' })
      })

      expect(() => writeFileAtomicallyIfUnchanged(target, 'approval = "never"\n', 'next')).toThrow(
        'no space'
      )
      undo()
      expect(readFileSync(`${target}.orca-guarded`, 'utf-8')).toBe('model = "o5"\n')
      expect(writeFileAtomicallyIfUnchanged(target, 'approval = "never"\n', 'next')).toBe(true)
      expect(
        readdirSync(dir)
          .filter((name) => name.includes('.orca-kept-'))
          .map((name) => readFileSync(join(dir, name), 'utf-8'))
      ).toEqual(['model = "o5"\n'])
    } finally {
      cleanup()
    }
  })

  it.skipIf(process.platform === 'win32')(
    'gives back a held file it cannot read instead of keeping a copy per conflict',
    () => {
      setup()
      try {
        const target = join(dir, 'config.toml')
        const heldPath = `${target}.orca-guarded`
        writeFileSync(target, 'approval = "never"\n')
        writeFileSync(heldPath, 'model = "o5"\n', { mode: 0o000 })

        expect(() => recoverInterruptedGuardedFileOperation(target)).toThrow()
        expect(() => recoverInterruptedGuardedFileOperation(target)).toThrow()
        expect(readdirSync(dir).sort()).toEqual(['config.toml', 'config.toml.orca-guarded'])
      } finally {
        cleanup()
      }
    }
  )

  it('never replaces a file another program saves under the kept name meanwhile', () => {
    setup()
    try {
      const target = join(dir, 'config.toml')
      writeFileSync(`${target}.orca-guarded`, 'model = "o5"\n')
      writeFileSync(target, 'approval = "never"\n')
      const link = fsMock.linkSync.getMockImplementation()!
      const undo = onFirstCallTo(fsMock.linkSync, isKept, (source, kept) => {
        writeFileSync(kept, 'theirs\n')
        link(source, kept)
      })

      recoverInterruptedGuardedFileOperation(target)
      undo()
      expect(
        readdirSync(dir)
          .filter((name) => name.includes('.orca-kept-'))
          .map((name) => readFileSync(join(dir, name), 'utf-8'))
          .sort()
      ).toEqual(['model = "o5"\n', 'theirs\n'])
    } finally {
      cleanup()
    }
  })

  it('puts the user file back even when the temp file cannot be deleted', () => {
    setup()
    try {
      const target = join(dir, 'config.toml')
      writeFileSync(target, 'user edit\n')
      const rm = fsMock.rmSync.getMockImplementation()!
      fsMock.rmSync.mockImplementation((path: string, options?: NodeFs.RmOptions) => {
        if (path.endsWith('.tmp')) {
          throw Object.assign(new Error('busy'), { code: 'EBUSY' })
        }
        return rm(path, options)
      })

      expect(() => writeFileAtomicallyIfUnchanged(target, 'stale\n', 'mirror\n')).toThrow('busy')
      fsMock.rmSync.mockImplementation(rm)
      expect(readFileSync(target, 'utf-8')).toBe('user edit\n')
    } finally {
      cleanup()
    }
  })

  it('restores the user file even when giving the held file back by link fails too', () => {
    setup()
    try {
      const target = join(dir, 'config.toml')
      writeFileSync(`${target}.orca-guarded`, 'user edit\n')
      const link = fsMock.linkSync.getMockImplementation()!
      const full = Object.assign(new Error('no space'), { code: 'ENOSPC' })
      fsMock.linkSync.mockImplementation((source: string, destination: string) => {
        if (destination === target || isHeld(destination)) {
          throw full
        }
        return link(source, destination)
      })

      expect(() => recoverInterruptedGuardedFileOperation(target)).toThrow('no space')
      fsMock.linkSync.mockImplementation(link)
      expect(writeFileAtomicallyIfUnchanged(target, null, 'fresh\n')).toBe(false)
      expect(readFileSync(target, 'utf-8')).toBe('user edit\n')
    } finally {
      cleanup()
    }
  })

  it('restores the user file on the next write after a failed restore', () => {
    setup()
    try {
      const target = join(dir, 'config.toml')
      writeFileSync(target, 'user edit\n')
      const undo = onFirstCallTo(
        fsMock.linkSync,
        (destination) => destination === target,
        () => {
          throw Object.assign(new Error('io'), { code: 'EIO' })
        }
      )

      expect(() => writeFileAtomicallyIfUnchanged(target, 'stale\n', 'mirror\n')).toThrow('io')
      undo()
      expect(writeFileAtomicallyIfUnchanged(target, null, 'fresh\n')).toBe(false)
      expect(readFileSync(target, 'utf-8')).toBe('user edit\n')
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
      const rename = fsMock.renameSync.getMockImplementation()!
      const undo = onFirstCallTo(fsMock.renameSync, isHeld, (source, destination) => {
        rename(source, destination)
        writeFileSync(target, 'concurrent')
      })

      expect(removeFileAtomicallyIfUnchanged(target, 'baseline')).toBe(false)
      undo()
      expect(readFileSync(target, 'utf-8')).toBe('concurrent')
    } finally {
      cleanup()
    }
  })

  it('updates only over the expected bytes on a filesystem with no hard links (STA-16341)', () => {
    setup()
    const link = fsMock.linkSync.getMockImplementation()!
    try {
      const target = join(dir, 'config.toml')
      writeFileSync(target, 'user edit\n')
      fsMock.linkSync.mockImplementation(() => {
        throw Object.assign(new Error('operation not supported'), { code: 'ENOTSUP' })
      })

      expect(writeFileAtomicallyIfUnchanged(target, 'stale\n', 'mirror\n')).toBe(false)
      expect(readFileSync(target, 'utf-8')).toBe('user edit\n')
      expect(writeFileAtomicallyIfUnchanged(target, 'user edit\n', 'mirror\n')).toBe(true)
      expect(readFileSync(target, 'utf-8')).toBe('mirror\n')
      expect(writeFileAtomicallyIfUnchanged(target, null, 'fresh\n')).toBe(false)
      expect(readFileSync(target, 'utf-8')).toBe('mirror\n')
      rmSync(target)
      expect(writeFileAtomicallyIfUnchanged(target, null, 'fresh\n')).toBe(true)
      expect(readFileSync(target, 'utf-8')).toBe('fresh\n')
      expect(readdirSync(dir)).toEqual(['config.toml'])
    } finally {
      fsMock.linkSync.mockImplementation(link)
      cleanup()
    }
  })
})
