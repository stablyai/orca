import * as gitSpawn from '../../git/command-runner/git-spawn'
import { realpath, lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import './runtime-test-module-registration.spec'
import '../../../shared/repo-badge-color'
import { EventEmitter } from 'node:events'
import { OrcaRuntimeService } from '../orca-runtime'
import {
  clearSubmodulePathsCacheForTests,
  listSubmodulePaths
} from '../../git/source-control/submodules/submodule-paths'
import { execFileSync } from 'node:child_process'
import '../orca-runtime-test-mocks/setup.spec'
import { join } from 'node:path'
import 'node:fs'
import '../../../shared/project-host-setup-projection'
import { tmpdir } from 'node:os'
import { createRuntime, store } from './orca-runtime-test-fixtures.spec'
import '../../../shared/cross-platform-path'

// Clone and create register resolved paths (macOS tmpdir is a /var symlink).
async function mkdtempReal(prefix: string): Promise<string> {
  return realpath(await mkdtemp(prefix))
}

describe('OrcaRuntimeService', () => {
  it('drops a same-path negative submodule cache before runtime cloneRepo', async () => {
    const spawnSpy = vi.spyOn(gitSpawn, 'gitSpawnAfterWindowsEnvironmentReady')
    const destination = await mkdtempReal(join(tmpdir(), 'orca-runtime-reclone-'))
    const clonePath = join(destination, 'reclone')
    const added: Record<string, unknown>[] = []
    const cloneStore = {
      ...store,
      getRepos: () => [...added] as never,
      addRepo: (repo: Record<string, unknown>) => added.push(repo),
      getRepo: (id: string) => added.find((repo) => repo.id === id) as never
    }
    spawnSpy.mockImplementation(() => {
      const proc = new EventEmitter() as EventEmitter & { stderr: EventEmitter }
      proc.stderr = new EventEmitter()
      setImmediate(() => {
        void mkdir(clonePath, { recursive: true })
          .then(() =>
            writeFile(join(clonePath, '.gitmodules'), '[submodule "lib"]\n\tpath = vendor/lib\n')
          )
          .then(() => proc.emit('close', 0, null))
      })
      return proc as never
    })
    const runtime = new OrcaRuntimeService(cloneStore as never)

    try {
      clearSubmodulePathsCacheForTests()
      await expect(listSubmodulePaths(clonePath)).resolves.toEqual([])
      await runtime.cloneRepo('https://example.com/reclone.git', destination)
      await expect(listSubmodulePaths(clonePath)).resolves.toEqual(['vendor/lib'])
    } finally {
      clearSubmodulePathsCacheForTests()
      spawnSpy.mockRestore()
      await rm(destination, { recursive: true, force: true })
    }
  })

  it('removes an owned runtime clone target when git exits unsuccessfully', async () => {
    const spawnSpy = vi.spyOn(gitSpawn, 'gitSpawnAfterWindowsEnvironmentReady')
    const proc = new EventEmitter() as EventEmitter & { stderr: EventEmitter }
    proc.stderr = new EventEmitter()
    spawnSpy.mockResolvedValue(proc as never)
    const runtime = createRuntime()
    const destination = await mkdtempReal(join(tmpdir(), 'orca-runtime-clone-'))
    const clonePath = join(destination, 'repo-badge-color')

    try {
      const clonePromise = runtime.cloneRepo(
        'https://example.com/repo-badge-color.git',
        destination
      )
      await vi.waitFor(() => expect(spawnSpy).toHaveBeenCalledTimes(1))
      await writeFile(join(clonePath, 'partial.txt'), 'git wrote this before failing')
      proc.stderr.emit('data', Buffer.from('fatal: repository not found\n'))
      proc.emit('close', 128, null)

      await expect(clonePromise).rejects.toThrow('Clone failed: fatal: repository not found')
      await expect(lstat(clonePath)).rejects.toThrow()
    } finally {
      spawnSpy.mockRestore()
      await rm(destination, { recursive: true, force: true })
    }
  })

  it('preserves an existing runtime clone target when git exits unsuccessfully', async () => {
    const spawnSpy = vi.spyOn(gitSpawn, 'gitSpawnAfterWindowsEnvironmentReady')
    const proc = new EventEmitter() as EventEmitter & { stderr: EventEmitter }
    proc.stderr = new EventEmitter()
    spawnSpy.mockResolvedValue(proc as never)
    const runtime = createRuntime()
    const destination = await mkdtempReal(join(tmpdir(), 'orca-runtime-clone-'))
    const clonePath = join(destination, 'repo-badge-color')

    try {
      await mkdir(clonePath)
      await writeFile(join(clonePath, 'user-file.txt'), 'keep me')
      const clonePromise = runtime.cloneRepo(
        'https://example.com/repo-badge-color.git',
        destination
      )
      await vi.waitFor(() => expect(spawnSpy).toHaveBeenCalledTimes(1))
      proc.emit('close', 128, null)

      await expect(clonePromise).rejects.toThrow('Clone failed')
      await expect(lstat(join(clonePath, 'user-file.txt'))).resolves.toBeTruthy()
    } finally {
      spawnSpy.mockRestore()
      await rm(destination, { recursive: true, force: true })
    }
  })

  it('skips runtime clone failure cleanup when the owned target is replaced', async () => {
    const spawnSpy = vi.spyOn(gitSpawn, 'gitSpawnAfterWindowsEnvironmentReady')
    const proc = new EventEmitter() as EventEmitter & { stderr: EventEmitter }
    proc.stderr = new EventEmitter()
    spawnSpy.mockResolvedValue(proc as never)
    const runtime = createRuntime()
    const destination = await mkdtempReal(join(tmpdir(), 'orca-runtime-clone-'))
    const clonePath = join(destination, 'repo-badge-color')
    const replacementFile = join(clonePath, 'replacement.txt')

    try {
      const clonePromise = runtime.cloneRepo(
        'https://example.com/repo-badge-color.git',
        destination
      )
      await vi.waitFor(() => expect(spawnSpy).toHaveBeenCalledTimes(1))
      await rm(clonePath, { recursive: true, force: true })
      await mkdir(clonePath)
      await writeFile(replacementFile, 'new owner')
      proc.emit('close', 128, null)

      await expect(clonePromise).rejects.toThrow('Clone failed')
      await expect(lstat(replacementFile)).resolves.toBeTruthy()
    } finally {
      spawnSpy.mockRestore()
      await rm(destination, { recursive: true, force: true })
    }
  })

  it('serializes concurrent runtime clones for the same target', async () => {
    const spawnSpy = vi.spyOn(gitSpawn, 'gitSpawnAfterWindowsEnvironmentReady')
    const firstProc = new EventEmitter() as EventEmitter & { stderr: EventEmitter }
    firstProc.stderr = new EventEmitter()
    spawnSpy.mockResolvedValueOnce(firstProc as never)
    const added: Record<string, unknown>[] = []
    const colorStore = {
      ...store,
      getRepos: () => [...added] as never,
      addRepo: (repo: Record<string, unknown>) => {
        added.push(repo)
      },
      getRepo: (id: string) => added.find((repo) => repo.id === id) as never
    }
    const runtime = new OrcaRuntimeService(colorStore as never)
    const destination = await mkdtempReal(join(tmpdir(), 'orca-runtime-clone-'))

    try {
      const url = 'https://example.com/repo-badge-color.git'
      const firstClonePromise = runtime.cloneRepo(url, destination)
      const secondClonePromise = runtime.cloneRepo(url, destination)
      await vi.waitFor(() => expect(spawnSpy).toHaveBeenCalledTimes(1))
      await new Promise((resolve) => setImmediate(resolve))
      expect(spawnSpy).toHaveBeenCalledTimes(1)

      // The queued request must find a finished clone of the URL where the first one landed.
      const clonePath = join(destination, 'repo-badge-color')
      execFileSync('git', ['init', '-q', clonePath])
      execFileSync('git', ['-C', clonePath, 'remote', 'add', 'origin', url])
      execFileSync('git', [
        '-C',
        clonePath,
        '-c',
        'user.name=Orca Test',
        '-c',
        'user.email=test@orca.invalid',
        'commit',
        '-q',
        '--allow-empty',
        '-m',
        'init'
      ])
      firstProc.emit('close', 0, null)
      await expect(firstClonePromise).resolves.toMatchObject({
        path: join(destination, 'repo-badge-color')
      })
      await expect(secondClonePromise).resolves.toMatchObject({
        path: join(destination, 'repo-badge-color')
      })
      expect(spawnSpy).toHaveBeenCalledTimes(1)
    } finally {
      spawnSpy.mockRestore()
      await rm(destination, { recursive: true, force: true })
    }
  })
})
