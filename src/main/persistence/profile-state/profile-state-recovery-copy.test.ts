import {
  closeSync,
  copyFileSync,
  existsSync,
  ftruncateSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  writeSync
} from 'node:fs'
import type * as FileSystem from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as processes from '../../../shared/child-process/run-process'
import { copyProfileStateRecoveryFile } from './profile-state-recovery-copy'

const cloneLink = vi.hoisted(() => ({ unsupported: false }))
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof FileSystem>()
  return {
    ...actual,
    linkSync: (...args: Parameters<typeof actual.linkSync>) => {
      if (cloneLink.unsupported) {
        throw Object.assign(new Error('hardlinks unavailable'), { code: 'ENOTSUP' })
      }
      return actual.linkSync(...args)
    }
  }
})

const directories: string[] = []
afterEach(() => {
  cloneLink.unsupported = false
  vi.restoreAllMocks()
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function fixture(large = true) {
  const directory = mkdtempSync(join(tmpdir(), 'orca-recovery-copy-'))
  directories.push(directory)
  const source = join(directory, '- source with spaces')
  const target = join(directory, 'target')
  const descriptor = openSync(source, 'wx', 0o600)
  try {
    ftruncateSync(descriptor, large ? 8 * 1024 * 1024 + 1 : 100)
    writeSync(descriptor, Buffer.from('retained source'))
  } finally {
    closeSync(descriptor)
  }
  return { directory, source, target }
}

function expectNoTemporary(directory: string): void {
  expect(readdirSync(directory).some((name) => name.startsWith('.orca-recovery-clone-'))).toBe(
    false
  )
}

describe('independent profile recovery copies', () => {
  it.each([false, true])('preserves independent bytes with a large file=%s', (large) => {
    const { directory, source, target } = fixture(large)
    const before = readFileSync(source)
    copyProfileStateRecoveryFile(source, target)
    expect(readFileSync(target).equals(before)).toBe(true)
    expect(statSync(target, { bigint: true }).ino).not.toBe(statSync(source, { bigint: true }).ino)
    writeFileSync(source, 'changed source')
    expect(readFileSync(target).equals(before)).toBe(true)
    writeFileSync(target, 'changed target')
    expect(readFileSync(source, 'utf8')).toBe('changed source')
    expectNoTemporary(directory)
  })

  it.each([false, true])('never replaces an existing destination with a large file=%s', (large) => {
    const { directory, source, target } = fixture(large)
    writeFileSync(target, 'do not replace')
    expect(() => copyProfileStateRecoveryFile(source, target)).toThrow()
    expect(readFileSync(target, 'utf8')).toBe('do not replace')
    expectNoTemporary(directory)
  })

  it('does not start a copy process for small files', () => {
    const { source, target } = fixture(false)
    const run = vi.spyOn(processes, 'runProcessSync')
    copyProfileStateRecoveryFile(source, target)
    expect(run).not.toHaveBeenCalled()
  })

  describe.skipIf(process.platform !== 'darwin')('Darwin clone failure boundaries', () => {
    it('resolves both process arguments while preserving relative path behavior', () => {
      const { directory, source, target } = fixture()
      const run = vi.spyOn(processes, 'runProcessSync')
      copyProfileStateRecoveryFile(relative(process.cwd(), source), relative(process.cwd(), target))
      const args = run.mock.calls[0]?.[0].args
      expect(args?.[0]).toBe('-c')
      expect(isAbsolute(args?.[1] ?? '')).toBe(true)
      expect(isAbsolute(args?.[2] ?? '')).toBe(true)
      expect(readFileSync(target).equals(readFileSync(source))).toBe(true)
      expectNoTemporary(directory)
    })

    it('keeps ordinary-copy semantics for symlinks to large recovery artifacts', () => {
      const { directory, source, target } = fixture()
      const alias = join(directory, 'alias')
      symlinkSync(source, alias)
      const run = vi.spyOn(processes, 'runProcessSync')
      copyProfileStateRecoveryFile(alias, target)
      expect(run).not.toHaveBeenCalled()
      expect(readFileSync(target).equals(readFileSync(source))).toBe(true)
      expect(statSync(target, { bigint: true }).ino).not.toBe(
        statSync(source, { bigint: true }).ino
      )
      expectNoTemporary(directory)
    })

    it('cleans a failed partial clone and falls back to an independent ordinary copy', () => {
      const { directory, source, target } = fixture()
      vi.spyOn(processes, 'runProcessSync').mockImplementation((spec) => {
        const temporary = spec.args?.[2]
        if (typeof temporary !== 'string') {
          throw new Error('Missing clone destination')
        }
        expect(statSync(dirname(temporary)).mode & 0o777).toBe(0o700)
        writeFileSync(temporary, 'incomplete')
        return { code: 1, signal: null, timedOut: false, stdout: '', stderr: 'clone unavailable' }
      })
      copyProfileStateRecoveryFile(source, target)
      expect(readFileSync(target).equals(readFileSync(source))).toBe(true)
      expect(statSync(target, { bigint: true }).ino).not.toBe(
        statSync(source, { bigint: true }).ino
      )
      expectNoTemporary(directory)
    })

    it.each(['timeout', 'signal', 'spawn'] as const)(
      'preserves originals and removes temporary copies after %s failure',
      (failure) => {
        const { directory, source, target } = fixture()
        const before = readFileSync(source)
        vi.spyOn(processes, 'runProcessSync').mockImplementation(() => {
          if (failure === 'spawn') {
            throw new Error('copy process could not start')
          }
          return {
            code: null,
            signal: 'SIGTERM',
            timedOut: failure === 'timeout',
            stdout: '',
            stderr: ''
          }
        })
        expect(() => copyProfileStateRecoveryFile(source, target)).toThrow()
        expect(readFileSync(source).equals(before)).toBe(true)
        expect(existsSync(target)).toBe(false)
        expectNoTemporary(directory)
      }
    )

    it('preserves a destination created while the clone process runs', () => {
      const { directory, source, target } = fixture()
      vi.spyOn(processes, 'runProcessSync').mockImplementation((spec) => {
        const temporary = spec.args?.[2]
        if (typeof temporary !== 'string') {
          throw new Error('Missing clone destination')
        }
        copyFileSync(source, temporary)
        writeFileSync(target, 'concurrent destination')
        return { code: 0, signal: null, timedOut: false, stdout: '', stderr: '' }
      })
      expect(() => copyProfileStateRecoveryFile(source, target)).toThrow()
      expect(readFileSync(target, 'utf8')).toBe('concurrent destination')
      expectNoTemporary(directory)
    })

    it('falls back when the destination filesystem does not support hardlinks', () => {
      const { directory, source, target } = fixture()
      cloneLink.unsupported = true
      copyProfileStateRecoveryFile(source, target)
      expect(readFileSync(target).equals(readFileSync(source))).toBe(true)
      expect(statSync(target, { bigint: true }).ino).not.toBe(
        statSync(source, { bigint: true }).ino
      )
      expectNoTemporary(directory)
    })
  })
})
