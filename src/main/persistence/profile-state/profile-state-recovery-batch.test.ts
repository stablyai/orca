import {
  closeSync,
  copyFileSync,
  existsSync,
  ftruncateSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync
} from 'node:fs'
import type * as FileSystem from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as processes from '../../../shared/child-process/run-process'
import { copyProfileStateRecoveryFiles } from './profile-state-recovery-copy'
import { quarantineProfileStateDatabase } from './profile-state-database-quarantine'

const publication = vi.hoisted(() => ({ unsupportedTarget: '' }))
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof FileSystem>()
  return {
    ...actual,
    linkSync: (...args: Parameters<typeof actual.linkSync>) => {
      if (args[1] === publication.unsupportedTarget) {
        throw Object.assign(new Error('hardlinks unavailable'), { code: 'ENOTSUP' })
      }
      return actual.linkSync(...args)
    }
  }
})

const directories: string[] = []
afterEach(() => {
  publication.unsupportedTarget = ''
  vi.restoreAllMocks()
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function fixture(names = ['primary.db', 'backup.db'], large = true) {
  const directory = mkdtempSync(join(tmpdir(), 'orca-recovery-batch-'))
  directories.push(directory)
  const files = names.map((name, index) => {
    const sourceDirectory = join(directory, `source-${index}`)
    mkdirSync(sourceDirectory)
    const source = join(sourceDirectory, name)
    const descriptor = openSync(source, 'wx', 0o600)
    try {
      ftruncateSync(descriptor, large ? 8 * 1024 * 1024 + 1 : 128)
      writeSync(descriptor, Buffer.from(`retained-${index}`))
    } finally {
      closeSync(descriptor)
    }
    return { source, target: join(directory, `restored-${index}.db`) }
  })
  return { directory, files }
}

function expectIndependent(files: ReturnType<typeof fixture>['files']): void {
  for (const { source, target } of files) {
    const original = readFileSync(source)
    expect(readFileSync(target).equals(original)).toBe(true)
    expect(statSync(source, { bigint: true }).ino).not.toBe(statSync(target, { bigint: true }).ino)
    writeFileSync(source, 'changed source')
    expect(readFileSync(target).equals(original)).toBe(true)
  }
}

function expectNoTemporary(directory: string): void {
  expect(readdirSync(directory).some((name) => name.startsWith('.orca-recovery-clone-'))).toBe(
    false
  )
}

describe('batched profile recovery copies', () => {
  it.each(['manifest.json', 'MANIFEST.JSON'])(
    'preserves a recovery artifact named %s without overwriting it with a manifest',
    (name) => {
      const { directory, files } = fixture(['primary.db', name], false)
      const artifact = files[1].source
      const original = readFileSync(artifact)
      const quarantine = () =>
        quarantineProfileStateDatabase(files[0].source, 'profile', directory, 'test', [artifact])
      if (existsSync(join(dirname(artifact), 'manifest.json'))) {
        expect(quarantine).toThrow('conflicts with the quarantine manifest')
        expect(
          readdirSync(directory).some((entry) => entry.startsWith('profile-state-corrupt-'))
        ).toBe(false)
      } else {
        const result = quarantine()
        expect(readFileSync(join(result.directory, name)).equals(original)).toBe(true)
      }
      expect(readFileSync(artifact).equals(original)).toBe(true)
      expect(existsSync(files[0].source)).toBe(true)
    }
  )

  it.each([false, true])('preserves every independent file with large copies=%s', (large) => {
    const { directory, files } = fixture(undefined, large)
    copyProfileStateRecoveryFiles(files)
    expectIndependent(files)
    expectNoTemporary(directory)
  })

  it('does nothing for an empty batch', () => {
    const run = vi.spyOn(processes, 'runProcessSync')
    copyProfileStateRecoveryFiles([])
    expect(run).not.toHaveBeenCalled()
  })

  describe.skipIf(process.platform !== 'darwin')('Darwin batch boundaries', () => {
    it('shares one process with absolute arguments and the per-file timeout budget', () => {
      const { directory, files } = fixture()
      const run = vi.spyOn(processes, 'runProcessSync')
      copyProfileStateRecoveryFiles(files)
      expect(run).toHaveBeenCalledOnce()
      const spec = run.mock.calls[0]?.[0]
      expect(spec?.args?.slice(1).every(isAbsolute)).toBe(true)
      expect(spec?.args).toHaveLength(4)
      expect(spec?.timeoutMs).toBe(60_000)
      expectIndependent(files)
      expectNoTemporary(directory)
    })

    it('bounds a shared process when many large artifacts are retained', () => {
      const { directory, files } = fixture(
        Array.from({ length: 17 }, (_, index) => `backup-${index}.db`)
      )
      const run = vi.spyOn(processes, 'runProcessSync')
      copyProfileStateRecoveryFiles(files)
      expect(run).toHaveBeenCalledTimes(2)
      expect(run.mock.calls.every(([spec]) => (spec.args?.length ?? 0) <= 18)).toBe(true)
      expectIndependent(files)
      expectNoTemporary(directory)
    })

    it.each([
      ['same.db', 'same.db'],
      ['CASE.db', 'case.db'],
      ['é.db', 'e\u0301.db'],
      ['suffix.db.', 'suffix.db'],
      ['- leading space.db', 'plain.db']
    ])('isolates ambiguous source names %s and %s', (...names) => {
      const { directory, files } = fixture(names)
      const run = vi.spyOn(processes, 'runProcessSync')
      copyProfileStateRecoveryFiles(files)
      expect(run).toHaveBeenCalledTimes(2)
      expectIndependent(files)
      expectNoTemporary(directory)
    })

    it.each(['timeout', 'signal', 'spawn'] as const)(
      'publishes no cloned files after a batch %s failure',
      (failure) => {
        const { directory, files } = fixture()
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
        expect(() => copyProfileStateRecoveryFiles(files)).toThrow()
        for (const { source, target } of files) {
          expect(existsSync(source)).toBe(true)
          expect(existsSync(target)).toBe(false)
        }
        expectNoTemporary(directory)
      }
    )

    it('discards partial process output before falling back for every source', () => {
      const { directory, files } = fixture()
      vi.spyOn(processes, 'runProcessSync').mockImplementation((spec) => {
        const temporaryDirectory = spec.args?.at(-1)
        if (!temporaryDirectory) {
          throw new Error('Missing clone directory')
        }
        expect(statSync(temporaryDirectory).mode & 0o777).toBe(0o700)
        writeFileSync(join(temporaryDirectory, basename(files[0].source)), 'incomplete')
        return { code: 1, signal: null, timedOut: false, stdout: '', stderr: 'clone unavailable' }
      })
      copyProfileStateRecoveryFiles(files)
      expectIndependent(files)
      expectNoTemporary(directory)
    })

    it('preserves a destination created during the batch process', () => {
      const { directory, files } = fixture()
      vi.spyOn(processes, 'runProcessSync').mockImplementation((spec) => {
        const temporaryDirectory = spec.args?.at(-1)
        if (!temporaryDirectory) {
          throw new Error('Missing clone directory')
        }
        for (const { source } of files) {
          copyFileSync(source, join(temporaryDirectory, basename(source)))
        }
        writeFileSync(files[1].target, 'concurrent destination')
        return { code: 0, signal: null, timedOut: false, stdout: '', stderr: '' }
      })
      expect(() => copyProfileStateRecoveryFiles(files)).toThrow()
      expect(readFileSync(files[1].target, 'utf8')).toBe('concurrent destination')
      expect(readFileSync(files[0].target).equals(readFileSync(files[0].source))).toBe(true)
      expectNoTemporary(directory)
    })

    it('falls back independently when one destination cannot publish hardlinks', () => {
      const { directory, files } = fixture()
      publication.unsupportedTarget = files[1].target
      copyProfileStateRecoveryFiles(files)
      expectIndependent(files)
      expectNoTemporary(directory)
    })
  })
})
