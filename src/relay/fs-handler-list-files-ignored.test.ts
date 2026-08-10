import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest'

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn()
}))

vi.mock('child_process', () => ({
  spawn: spawnMock
}))

import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { listFilesWithGit } from './fs-handler-git-fallback'
import { listFilesWithRg } from './fs-handler-list-files'
import { searchWithRg } from './fs-handler-utils'
import { RipgrepUnavailableError } from '../shared/ripgrep-process-availability'
import {
  ListFilesScanCoordinator,
  LIST_FILES_SUPERSEDED_MESSAGE
} from './fs-list-files-scan-coordinator'

const tempDirs: string[] = []
const SHA1 = '0123456789abcdef0123456789abcdef01234567'

function staged(mode: string, path: string): string {
  return `${mode} ${SHA1} 0\t${path}`
}

function createMockProcess(): ChildProcess {
  const p = new EventEmitter() as unknown as ChildProcess
  ;(p as unknown as Record<string, unknown>).stdout = new EventEmitter()
  ;(
    (p as unknown as Record<string, unknown>).stdout as EventEmitter & {
      setEncoding: () => void
    }
  ).setEncoding = vi.fn()
  ;(p as unknown as Record<string, unknown>).stderr = new EventEmitter()
  ;(p as unknown as Record<string, unknown>).kill = vi.fn()
  ;(p as unknown as Record<string, unknown>).exitCode = null
  ;(p as unknown as Record<string, unknown>).signalCode = null
  Object.defineProperty(p, 'pid', { configurable: true, value: 1 })
  return p
}

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-relay-git-list-files-'))
  tempDirs.push(root)
  return root
}

async function writeRel(root: string, relPath: string, content = 'x'): Promise<void> {
  const absPath = join(root, ...relPath.split('/'))
  await mkdir(dirname(absPath), { recursive: true })
  await writeFile(absPath, content)
}

describe('relay quick open ignored file listing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  it('rg ignored pass includes ignored non-env files and keeps blocklists/excludes', async () => {
    const primaryProc = createMockProcess()
    const ignoredProc = createMockProcess()

    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('--no-ignore-vcs')) {
        return ignoredProc
      }
      return primaryProc
    })

    const promise = listFilesWithRg('/remote/root', ['packages/other'])
    expect(spawnMock).toHaveBeenCalledTimes(2)

    setTimeout(() => {
      ;(primaryProc.stdout as unknown as EventEmitter).emit('data', 'src/index.ts\n')
      primaryProc.emit('close', 0, null)

      ;(ignoredProc.stdout as unknown as EventEmitter).emit('data', 'dist/generated.js\n')
      ;(ignoredProc.stdout as unknown as EventEmitter).emit('data', 'node_modules/pkg/index.js\n')
      ;(ignoredProc.stdout as unknown as EventEmitter).emit('data', 'packages/other/src/x.ts\n')
      ignoredProc.emit('close', 0, null)
    }, 10)

    await expect(promise).resolves.toEqual(['src/index.ts', 'dist/generated.js'])

    const ignoredArgs = spawnMock.mock.calls.find((call) =>
      (call[1] as string[]).includes('--no-ignore-vcs')
    )?.[1] as string[]
    expect(ignoredArgs).toBeDefined()
    expect(ignoredArgs).toContain('--no-ignore-vcs')
    expect(ignoredArgs).not.toContain('.env*')
    expect(ignoredArgs).not.toContain('**/.env*')
    expect(ignoredArgs).toContain('!**/node_modules')
    expect(ignoredArgs).toContain('!packages/other')
    expect(ignoredArgs).toContain('!packages/other/**')
  })

  it('stops after the primary relay rg pass fills the result budget', async () => {
    const primaryProc = createMockProcess()
    const ignoredProc = createMockProcess()
    let callIndex = 0
    spawnMock.mockImplementation(() => (++callIndex === 1 ? primaryProc : ignoredProc))

    const promise = listFilesWithRg('/remote/root', [], { maxResults: 2 })
    ;(primaryProc.stdout as unknown as EventEmitter).emit(
      'data',
      'src/one.ts\nsrc/two.ts\nsrc/three.ts\n'
    )

    await expect(promise).resolves.toEqual(['src/one.ts', 'src/two.ts'])
    expect(primaryProc.kill).toHaveBeenCalled()
    expect(ignoredProc.kill).not.toHaveBeenCalled()
    expect(callIndex).toBe(1)
  })

  it.each(['error-first', 'close-first'] as const)(
    'tags a %s pre-spawn listing failure without starting the ignored pass',
    async (order) => {
      const root = await makeTempRoot()
      const missing = createMockProcess()
      Object.defineProperty(missing, 'pid', { value: undefined })
      spawnMock.mockReturnValue(missing)
      const error = Object.assign(new Error('spawn rg ENOENT'), { code: 'ENOENT' })

      const promise = listFilesWithRg(root)
      if (order === 'error-first') {
        expect(() => missing.emit('error', error)).not.toThrow()
      } else {
        missing.emit('close', -2, null)
      }

      await expect(promise).rejects.toBeInstanceOf(RipgrepUnavailableError)
      if (order === 'error-first') {
        missing.emit('close', -2, null)
      } else {
        expect(() => missing.emit('error', error)).not.toThrow()
      }
      expect(spawnMock).toHaveBeenCalledTimes(1)
      expect(missing.listenerCount('error')).toBe(0)
      expect(missing.listenerCount('close')).toBe(0)
    }
  )

  it('kills only the admitted pass when ignored rg fails before spawn', async () => {
    const root = await makeTempRoot()
    const primary = createMockProcess()
    const missingIgnored = createMockProcess()
    Object.defineProperty(missingIgnored, 'pid', { value: undefined })
    spawnMock.mockImplementation((_cmd: string, args: string[]) =>
      args.includes('--no-ignore-vcs') ? missingIgnored : primary
    )

    const promise = listFilesWithRg(root)
    expect(spawnMock).toHaveBeenCalledTimes(2)
    missingIgnored.emit('close', -2, null)

    await expect(promise).rejects.toBeInstanceOf(RipgrepUnavailableError)
    expect(primary.kill).toHaveBeenCalled()
    expect(missingIgnored.kill).not.toHaveBeenCalled()
    const error = Object.assign(new Error('spawn rg ENOENT'), { code: 'ENOENT' })
    expect(() => missingIgnored.emit('error', error)).not.toThrow()
    expect(missingIgnored.listenerCount('error')).toBe(0)
  })

  it('does not signal failed-spawn passes when a same-client scan is superseded', async () => {
    const root = await makeTempRoot()
    const firstChild = createMockProcess()
    Object.defineProperty(firstChild, 'pid', { value: undefined })
    spawnMock.mockReturnValue(firstChild)
    const coordinator = new ListFilesScanCoordinator()
    const first = coordinator.run({
      clientId: 1,
      key: 'first',
      start: (signal) => listFilesWithRg(root, [], { signal })
    })
    const firstOutcome = first.catch((error: unknown) => error)

    const second = coordinator.run({
      clientId: 1,
      key: 'second',
      start: async () => ['second.ts']
    })

    await expect(firstOutcome).resolves.toMatchObject({ message: LIST_FILES_SUPERSEDED_MESSAGE })
    await expect(second).resolves.toEqual(['second.ts'])
    expect(firstChild.kill).not.toHaveBeenCalled()
    expect(spawnMock).toHaveBeenCalledTimes(1)
    const error = Object.assign(new Error('spawn rg ENOENT'), { code: 'ENOENT' })
    expect(() => firstChild.emit('error', error)).not.toThrow()
  })

  it('git fallback ignored pass includes ignored non-env files', async () => {
    const root = await makeTempRoot()
    await writeRel(root, 'dist/generated.js')
    const primaryProc = createMockProcess()
    const ignoredProc = createMockProcess()
    let callIndex = 0

    spawnMock.mockImplementation(() => {
      callIndex++
      return callIndex === 1 ? primaryProc : ignoredProc
    })

    const promise = listFilesWithGit(root, ['packages/other'])

    setTimeout(() => {
      ;(primaryProc.stdout as unknown as EventEmitter).emit(
        'data',
        `${staged('100644', 'src/index.ts')}\0`
      )
      ;(primaryProc.stdout as unknown as EventEmitter).emit(
        'data',
        `${staged('100644', 'tab\tfile.txt')}\0`
      )
      primaryProc.emit('close', 0, null)

      ;(ignoredProc.stdout as unknown as EventEmitter).emit('data', 'dist/\0')
      ;(ignoredProc.stdout as unknown as EventEmitter).emit('data', 'packages/other/src/x.ts\0')
      ignoredProc.emit('close', 0, null)
    }, 10)

    await expect(promise).resolves.toEqual(['dist/generated.js', 'src/index.ts', 'tab\tfile.txt'])

    const ignoredArgs = spawnMock.mock.calls[1][1] as string[]
    expect(ignoredArgs.slice(0, 6)).toEqual([
      'ls-files',
      '-z',
      '-s',
      '--others',
      '--ignored',
      '--exclude-standard'
    ])
    expect(ignoredArgs).toContain('--')
    expect(ignoredArgs).toContain('.')
    expect(ignoredArgs).toContain('--directory')
    expect(ignoredArgs).toContain('--no-empty-directory')
    expect(ignoredArgs).toContain(':(exclude,glob)packages/other')
    expect(ignoredArgs).toContain(':(exclude,glob)packages/other/**')
  })

  it('stops after primary relay Git files fill the result budget', async () => {
    const primaryProc = createMockProcess()
    const ignoredProc = createMockProcess()
    let callIndex = 0
    spawnMock.mockImplementation(() => (++callIndex === 1 ? primaryProc : ignoredProc))

    const promise = listFilesWithGit('/remote/root', [], { maxResults: 2 })
    ;(primaryProc.stdout as unknown as EventEmitter).emit('data', 'src/one.ts\0src/two.ts')
    primaryProc.emit('close', 0, null)
    await expect(promise).resolves.toEqual(['src/one.ts', 'src/two.ts'])
    expect(primaryProc.kill).toHaveBeenCalled()
    expect(ignoredProc.kill).not.toHaveBeenCalled()
    expect(callIndex).toBe(1)
  })

  it('does not let a discarded relay Git placeholder consume the result budget', async () => {
    const primaryProc = createMockProcess()
    spawnMock.mockReturnValue(primaryProc)

    const promise = listFilesWithGit('/remote/root', [], { maxResults: 1 })
    ;(primaryProc.stdout as unknown as EventEmitter).emit(
      'data',
      `discarded/\0${staged('100644', 'src/kept.ts')}\0`
    )

    await expect(promise).resolves.toEqual(['src/kept.ts'])
    expect(primaryProc.kill).toHaveBeenCalled()
  })

  it('git fallback fills nested git repos returned as root-relative placeholders', async () => {
    const root = await makeTempRoot()
    await writeRel(root, 'README.md')
    await mkdir(join(root, 'packages', 'app', '.git'), { recursive: true })
    await writeRel(root, 'packages/app/src/main.ts')
    await mkdir(join(root, 'packages', 'lib'), { recursive: true })
    await writeFile(join(root, 'packages', 'lib', '.git'), 'gitdir: ../.git/worktrees/lib')
    await writeRel(root, 'packages/lib/src/lib.ts')

    const primaryProc = createMockProcess()
    const ignoredProc = createMockProcess()
    let callIndex = 0

    spawnMock.mockImplementation(() => {
      callIndex++
      return callIndex === 1 ? primaryProc : ignoredProc
    })

    const promise = listFilesWithGit(root)

    setTimeout(() => {
      ;(primaryProc.stdout as unknown as EventEmitter).emit(
        'data',
        `${staged('100644', 'README.md')}\0${staged('160000', 'packages/app')}\0packages/lib/\0`
      )
      primaryProc.emit('close', 0, null)
      ignoredProc.emit('close', 0, null)
    }, 10)

    await expect(promise).resolves.toEqual([
      'README.md',
      'packages/app/src/main.ts',
      'packages/lib/src/lib.ts'
    ])
  })

  it('git fallback keeps primary results when the ignored pass is killed', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const primaryProc = createMockProcess()
      const ignoredProc = createMockProcess()
      let callIndex = 0

      spawnMock.mockImplementation(() => {
        callIndex++
        return callIndex === 1 ? primaryProc : ignoredProc
      })

      const promise = listFilesWithGit('/remote/root')

      setTimeout(() => {
        ;(primaryProc.stdout as unknown as EventEmitter).emit('data', 'src/index.ts\0')
        primaryProc.emit('close', 0, null)

        // Entries streamed before the kill are kept alongside the primary pass.
        ;(ignoredProc.stdout as unknown as EventEmitter).emit('data', 'dist/generated.js\0')
        ignoredProc.emit('close', null, 'SIGTERM')
      }, 10)

      await expect(promise).resolves.toEqual(['dist/generated.js', 'src/index.ts'])
      expect(warnSpy).toHaveBeenCalled()
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('git fallback keeps primary results when the ignored pass exits non-zero', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const primaryProc = createMockProcess()
      const ignoredProc = createMockProcess()
      let callIndex = 0

      spawnMock.mockImplementation(() => {
        callIndex++
        return callIndex === 1 ? primaryProc : ignoredProc
      })

      const promise = listFilesWithGit('/remote/root')

      setTimeout(() => {
        ;(primaryProc.stdout as unknown as EventEmitter).emit('data', 'src/index.ts\0')
        primaryProc.emit('close', 0, null)

        ignoredProc.emit('close', 128, null)
      }, 10)

      await expect(promise).resolves.toEqual(['src/index.ts'])
      expect(warnSpy).toHaveBeenCalled()
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('git fallback rejects when the primary pass is killed', async () => {
    const primaryProc = createMockProcess()
    const ignoredProc = createMockProcess()
    let callIndex = 0

    spawnMock.mockImplementation(() => {
      callIndex++
      return callIndex === 1 ? primaryProc : ignoredProc
    })

    const promise = listFilesWithGit('/remote/root')

    setTimeout(() => {
      ;(primaryProc.stdout as unknown as EventEmitter).emit('data', 'src/index.ts\0')
      primaryProc.emit('close', null, 'SIGTERM')

      ;(ignoredProc.stdout as unknown as EventEmitter).emit('data', 'dist/generated.js\0')
      ignoredProc.emit('close', 0, null)
    }, 10)

    await expect(promise).rejects.toThrow('git ls-files killed by SIGTERM')
  })

  it('git fallback rejects when the primary pass exits non-zero', async () => {
    const primaryProc = createMockProcess()
    const ignoredProc = createMockProcess()
    let callIndex = 0

    spawnMock.mockImplementation(() => {
      callIndex++
      return callIndex === 1 ? primaryProc : ignoredProc
    })

    const promise = listFilesWithGit('/remote/root')

    setTimeout(() => {
      primaryProc.emit('close', 128, null)

      ;(ignoredProc.stdout as unknown as EventEmitter).emit('data', 'dist/generated.js\0')
      ignoredProc.emit('close', 0, null)
    }, 10)

    await expect(promise).rejects.toThrow('git ls-files exited with code 128')
  })

  it('git fallback rejects when a timed-out child does not emit close', async () => {
    vi.useFakeTimers()
    try {
      const primaryProc = createMockProcess()
      const ignoredProc = createMockProcess()
      let callIndex = 0

      spawnMock.mockImplementation(() => {
        callIndex++
        return callIndex === 1 ? primaryProc : ignoredProc
      })

      const promise = listFilesWithGit('/remote/root')
      const outcomePromise = promise.then(
        () => 'resolved',
        (err: Error) => `rejected:${err.message}`
      )

      await vi.advanceTimersByTimeAsync(10_000)
      const outcome = await Promise.race([outcomePromise, Promise.resolve('pending')])

      expect(outcome).toContain('git ls-files timed out')
      expect(primaryProc.kill).toHaveBeenCalled()
      expect(ignoredProc.kill).toHaveBeenCalled()
      expect((primaryProc.stdout as unknown as EventEmitter).listenerCount('data')).toBe(0)
      expect((primaryProc.stderr as unknown as EventEmitter).listenerCount('data')).toBe(0)
      expect(primaryProc.listenerCount('error')).toBe(0)
      expect(primaryProc.listenerCount('close')).toBe(0)
      expect((ignoredProc.stdout as unknown as EventEmitter).listenerCount('data')).toBe(0)
      expect((ignoredProc.stderr as unknown as EventEmitter).listenerCount('data')).toBe(0)
      expect(ignoredProc.listenerCount('error')).toBe(0)
      expect(ignoredProc.listenerCount('close')).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('rg file listing rejects and detaches when a timed-out child does not emit close', async () => {
    vi.useFakeTimers()
    try {
      const primaryProc = createMockProcess()
      const ignoredProc = createMockProcess()
      let callIndex = 0

      spawnMock.mockImplementation(() => {
        callIndex++
        return callIndex === 1 ? primaryProc : ignoredProc
      })

      const promise = listFilesWithRg('/remote/root')
      const outcomePromise = promise.then(
        () => 'resolved',
        (err: Error) => `rejected:${err.message}`
      )

      await vi.advanceTimersByTimeAsync(25_000)
      const outcome = await Promise.race([outcomePromise, Promise.resolve('pending')])

      expect(outcome).toBe('rejected:rg list timed out')
      expect(primaryProc.kill).toHaveBeenCalled()
      expect(ignoredProc.kill).toHaveBeenCalled()
      expect((primaryProc.stdout as unknown as EventEmitter).listenerCount('data')).toBe(0)
      expect((primaryProc.stderr as unknown as EventEmitter).listenerCount('data')).toBe(0)
      expect(primaryProc.listenerCount('error')).toBe(0)
      expect(primaryProc.listenerCount('close')).toBe(0)
      expect((ignoredProc.stdout as unknown as EventEmitter).listenerCount('data')).toBe(0)
      expect((ignoredProc.stderr as unknown as EventEmitter).listenerCount('data')).toBe(0)
      expect(ignoredProc.listenerCount('error')).toBe(0)
      expect(ignoredProc.listenerCount('close')).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('rg search settles and detaches when a timed-out child does not emit close', async () => {
    vi.useFakeTimers()
    try {
      const proc = createMockProcess()
      spawnMock.mockReturnValue(proc)

      const promise = searchWithRg('/remote/root', 'ok', { maxResults: 100 })
      const outcomePromise = promise.then((result) =>
        result.truncated ? `truncated:${result.totalMatches}` : 'not-truncated'
      )

      await vi.runOnlyPendingTimersAsync()
      const outcome = await Promise.race([outcomePromise, Promise.resolve('pending')])

      expect(outcome).toBe('truncated:0')
      expect(proc.kill).toHaveBeenCalled()
      expect((proc.stdout as unknown as EventEmitter).listenerCount('data')).toBe(0)
      expect((proc.stderr as unknown as EventEmitter).listenerCount('data')).toBe(0)
      expect(proc.listenerCount('error')).toBe(0)
      expect(proc.listenerCount('close')).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it.each(['error-first', 'close-first'] as const)(
    'tags only a %s pre-spawn rg search failure as unavailable',
    async (order) => {
      const root = await makeTempRoot()
      const missing = createMockProcess()
      Object.defineProperty(missing, 'pid', { value: undefined })
      spawnMock.mockReturnValueOnce(missing)
      const unavailable = searchWithRg(root, 'ok', { maxResults: 100 })
      const error = Object.assign(new Error('spawn rg ENOENT'), { code: 'ENOENT' })
      if (order === 'error-first') {
        expect(() => missing.emit('error', error)).not.toThrow()
        missing.emit('close', -2, null)
      } else {
        missing.emit('close', -2, null)
        expect(() => missing.emit('error', error)).not.toThrow()
      }

      await expect(unavailable).rejects.toBeInstanceOf(RipgrepUnavailableError)
      expect(missing.listenerCount('error')).toBe(0)
      expect(missing.listenerCount('close')).toBe(0)
    }
  )

  it('tags unsupported native launcher exits as unavailable', async () => {
    const root = await makeTempRoot()
    const child = createMockProcess()
    Object.defineProperty(child, 'pid', { value: 1 })
    spawnMock.mockReturnValueOnce(child)
    const unavailable = searchWithRg(root, 'ok', { maxResults: 100 })

    child.emit('close', 127, null)

    await expect(unavailable).rejects.toBeInstanceOf(RipgrepUnavailableError)
  })

  it('keeps missing-root launch errors on their prior non-fallback paths', async () => {
    const missingRoot = await makeTempRoot()
    await rm(missingRoot, { recursive: true, force: true })
    const listFirst = createMockProcess()
    const listProbe = createMockProcess()
    Object.defineProperty(listFirst, 'pid', { value: undefined })
    Object.defineProperty(listProbe, 'pid', { value: 1 })
    let callIndex = 0
    spawnMock.mockImplementation(() => [listFirst, listProbe][callIndex++])
    const listError = Object.assign(new Error('spawn rg ENOENT'), { code: 'ENOENT' })
    const listing = listFilesWithRg(missingRoot)
    listFirst.emit('error', listError)

    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(2))
    expect(spawnMock.mock.calls[1]).toEqual(['rg', ['--version'], { stdio: 'ignore' }])
    listProbe.emit('close', 0, null)
    await expect(listing).rejects.toBe(listError)

    spawnMock.mockReset()
    const searchChild = createMockProcess()
    const searchProbe = createMockProcess()
    Object.defineProperty(searchChild, 'pid', { value: undefined })
    Object.defineProperty(searchProbe, 'pid', { value: 1 })
    spawnMock.mockReturnValueOnce(searchChild).mockReturnValueOnce(searchProbe)
    const search = searchWithRg(missingRoot, 'ok', { maxResults: 100 })
    searchChild.emit('error', listError)

    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(2))
    searchProbe.emit('close', 0, null)
    await expect(search).resolves.toMatchObject({ files: [], totalMatches: 0 })
  })

  it('keeps missing-rg precedence when the root also disappeared', async () => {
    const missingRoot = await makeTempRoot()
    await rm(missingRoot, { recursive: true, force: true })
    const first = createMockProcess()
    const probe = createMockProcess()
    for (const child of [first, probe]) {
      Object.defineProperty(child, 'pid', { value: undefined })
    }
    let callIndex = 0
    spawnMock.mockImplementation(() => [first, probe][callIndex++])
    const error = Object.assign(new Error('spawn rg ENOENT'), { code: 'ENOENT' })
    const listing = listFilesWithRg(missingRoot)
    first.emit('error', error)

    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(2))
    probe.emit('close', -2, null)

    await expect(listing).rejects.toBeInstanceOf(RipgrepUnavailableError)
    expect(() => probe.emit('error', error)).not.toThrow()
  })

  it('keeps post-spawn rg search errors on the existing empty-result path', async () => {
    const started = createMockProcess()
    Object.defineProperty(started, 'pid', { value: 1 })
    spawnMock.mockReturnValueOnce(started)
    const ordinaryFailure = searchWithRg('/remote/root', 'ok', { maxResults: 100 })
    started.emit('error', new Error('post-spawn failure'))
    await expect(ordinaryFailure).resolves.toMatchObject({ files: [], totalMatches: 0 })
  })
})
