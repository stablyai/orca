import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFakeSpawnedChild } from '../../../shared/__fixtures__/fake-spawned-child'
import { partialRuntimeStore } from '../orca-runtime-tests/runtime-store-partial-fixture'
import type { Repo } from '../../../shared/repo-types'

const { spawnMock, gitMock } = vi.hoisted(() => ({ spawnMock: vi.fn(), gitMock: vi.fn() }))
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  spawn: spawnMock
}))
vi.mock('../../git/command-runner/git-exec-file', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  gitExecFileAsync: gitMock
}))

import { RuntimeRepositoryForkBackfill } from './runtime-repository-fork-backfill'
import { ghExecFileAsync } from '../../git/command-runner/gh-exec-file'
import { GhExecutableAbsenceBatch } from '../../git/command-runner/gh-executable-absence-batch'

const missing = () => Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT', path: 'gh' })
function successfulSpawn() {
  const child = createFakeSpawnedChild(4321)
  queueMicrotask(() => {
    child.stdout?.emit(
      'data',
      Buffer.from('{"isFork":true,"parent":{"owner":{"login":"acme"},"name":"widget"}}')
    )
    child.emit('exit', 0, null)
    child.emit('close', 0, null)
  })
  return child
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  vi.resetAllMocks()
})

describe('finite metadata executable absence', () => {
  it.each([12, 120])(
    'shares only the missing executable across a %i-row real probe batch and retries next batch',
    async (count) => {
      const root = await mkdtemp(join(tmpdir(), 'orca-metadata-absence-'))
      const search = join(root, 'bin')
      await mkdir(search)
      vi.stubEnv('PATH', search)
      const repos: Repo[] = []
      for (let i = 0; i < count; i++) {
        const path = join(root, `repo-${i}`)
        await mkdir(path)
        repos.push({
          id: `repo-${i}`,
          path,
          displayName: 'widget',
          kind: 'git',
          badgeColor: 'blue',
          addedAt: 1
        })
      }
      gitMock.mockImplementation(async (args: string[], options: { cwd: string }) => {
        if (args[2] === 'origin') {
          return { stdout: 'https://github.com/me/widget.git', stderr: '' }
        }
        if (options.cwd === repos[1].path) {
          return { stdout: 'https://github.com/acme/widget.git', stderr: '' }
        }
        throw Object.assign(new Error('No such remote'), {
          code: 2,
          stderr: "error: No such remote 'upstream'"
        })
      })
      const notify = vi.fn()
      const store = partialRuntimeStore({
        getRepos: () => repos,
        getRepo: (id) => repos.find((repo) => repo.id === id),
        updateRepo: (target, updates) => {
          const repo = repos.find((repo) => repo.id === target.id)
          if (!repo) {
            return null
          }
          Object.assign(repo, updates)
          return repo
        }
      })
      const owner = new RuntimeRepositoryForkBackfill(() => store, notify)
      spawnMock.mockImplementation(() => {
        throw missing()
      })
      try {
        await owner.run()
        expect(spawnMock).toHaveBeenCalledTimes(1)
        expect(repos[0].upstream).toBeUndefined()
        expect(repos[0].repoIcon).toEqual({
          type: 'image',
          source: 'github',
          src: 'https://github.com/me.png?size=64',
          label: 'me/widget'
        })
        expect(repos[1].upstream).toEqual({ owner: 'acme', repo: 'widget', host: 'github.com' })
        expect(notify).toHaveBeenCalledTimes(1)
        spawnMock.mockImplementation(successfulSpawn)
        await owner.run()
        expect(repos.every((repo) => repo.upstream?.owner === 'acme')).toBe(true)
        expect(spawnMock).toHaveBeenCalledTimes(count)
        expect(notify).toHaveBeenCalledTimes(2)
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  )

  it('does not suppress a fresh explicit lookup, changed search context, or per-repository API failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-metadata-search-'))
    const other = join(root, 'other')
    await mkdir(other)
    const batch = new GhExecutableAbsenceBatch()
    const options = { cwd: root, env: { PATH: root } }
    spawnMock.mockImplementation(() => {
      throw missing()
    })
    try {
      await expect(
        batch.run(() => ghExecFileAsync(['repo', 'view', 'me/widget'], options))
      ).rejects.toThrow('ENOENT')
      await expect(
        batch.run(() => ghExecFileAsync(['repo', 'view', 'me/widget'], options))
      ).rejects.toThrow('ENOENT')
      expect(spawnMock).toHaveBeenCalledTimes(1)
      await expect(
        batch.run(() =>
          ghExecFileAsync(['repo', 'view', 'me/widget'], { ...options, env: { PATH: other } })
        )
      ).rejects.toThrow('ENOENT')
      expect(spawnMock).toHaveBeenCalledTimes(2)
      spawnMock.mockImplementation(successfulSpawn)
      // A required action runs outside the batch's absence evidence and invalidates it on success.
      await ghExecFileAsync(['repo', 'view', 'me/widget'], options)
      await batch.run(() => ghExecFileAsync(['repo', 'view', 'me/widget'], options))
      expect(spawnMock).toHaveBeenCalledTimes(4)
      spawnMock.mockImplementationOnce(() => {
        throw new Error('repository not authorized')
      })
      await expect(
        batch.run(() => ghExecFileAsync(['repo', 'view', 'private/widget'], options))
      ).rejects.toThrow('not authorized')
      await batch.run(() => ghExecFileAsync(['repo', 'view', 'public/widget'], options))
      expect(spawnMock).toHaveBeenCalledTimes(6)
      // An existing wrapper with an absent interpreter is not proof that gh is absent.
      await writeFile(
        join(root, process.platform === 'win32' ? 'gh.exe' : 'gh'),
        '#!/missing/interpreter\n'
      )
      await chmod(join(root, process.platform === 'win32' ? 'gh.exe' : 'gh'), 0o755)
      spawnMock.mockImplementation(() => {
        throw missing()
      })
      for (let i = 0; i < 2; i++) {
        await expect(
          batch.run(() => ghExecFileAsync(['repo', 'view', 'me/widget'], options))
        ).rejects.toThrow('ENOENT')
      }
      expect(spawnMock).toHaveBeenCalledTimes(8)
    } finally {
      batch.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})
