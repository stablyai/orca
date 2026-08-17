import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as GitRunner from '../git/runner'
import type * as RepoModule from '../git/repo'

const { reposMocks, moduleMocks } = await vi.hoisted(async () => {
  const moduleMocks = await import('./repos-remote-test-harness')
  return { reposMocks: moduleMocks.createReposIpcMocks(), moduleMocks }
})

vi.mock('electron', () => moduleMocks.electronModuleMock(reposMocks))
vi.mock('../git/repo', async (importOriginal) =>
  moduleMocks.gitRepoModuleMock(await importOriginal<typeof RepoModule>())
)
vi.mock('../git/runner', async (importOriginal) =>
  moduleMocks.gitRunnerModuleMock(reposMocks, await importOriginal<typeof GitRunner>())
)
vi.mock('../git/worktree', () => moduleMocks.gitWorktreeModuleMock(reposMocks))
vi.mock('./registered-worktree-roots-cache', () =>
  moduleMocks.registeredWorktreeRootsCacheModuleMock(reposMocks)
)
vi.mock('../worktree-root-preparation', () =>
  moduleMocks.worktreeRootPreparationModuleMock(reposMocks)
)
vi.mock('../providers/ssh-git-dispatch', () => moduleMocks.sshGitDispatchModuleMock(reposMocks))
vi.mock('../providers/ssh-filesystem-dispatch', () =>
  moduleMocks.sshFilesystemDispatchModuleMock(reposMocks)
)
vi.mock('./ssh', () => moduleMocks.sshModuleMock(reposMocks))

import { registerRepoHandlers } from './repos'
import { clearGitCapabilityStateForTests } from '../git/git-capability-state'
import { resetSshProviderAuthorities } from '../ssh/ssh-provider-authority'
import { DEFAULT_REPO_BADGE_COLOR } from '../../shared/constants'
import { listSubmodulePaths } from '../git/status'
import {
  createMockCloneProcess,
  createRepoHandlerHarness,
  resetLocalRepoMocks,
  waitForAssertion
} from './repos-remote-test-harness'

const {
  handleMock,
  mockStore,
  gitExecFileAsyncMock,
  gitSpawnMock,
  gitSpawnAfterWindowsEnvironmentReadyMock,
  invalidateAuthorizedRootsCacheMock,
  prepareLocalWorktreeRootForRepoMock
} = reposMocks

beforeEach(() => {
  clearGitCapabilityStateForTests()
  resetSshProviderAuthorities()
})

describe('repos:add + repos:clone', () => {
  const { handlers, mockWindow, captureHandlers } = createRepoHandlerHarness()
  const tempRoots: string[] = []

  const createTempRoot = async (): Promise<string> => {
    const root = await mkdtemp(join(tmpdir(), 'orca-repos-clone-'))
    tempRoots.push(root)
    return root
  }
  beforeEach(() => {
    captureHandlers(handleMock)
    resetLocalRepoMocks(reposMocks)
    mockWindow.webContents.send.mockReset()

    registerRepoHandlers(mockWindow as never, mockStore as never)
  })

  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  })

  it('defaults repos:clone badgeColor to DEFAULT_REPO_BADGE_COLOR', async () => {
    const destination = await createTempRoot()

    const result = await handlers.get('repos:clone')!(null, {
      url: 'https://example.com/orca.git',
      destination
    })

    expect(mockStore.addRepo).toHaveBeenCalledWith(
      expect.objectContaining({
        path: join(destination, 'orca'),
        badgeColor: DEFAULT_REPO_BADGE_COLOR,
        kind: 'git'
      })
    )
    expect(result).toHaveProperty('badgeColor', DEFAULT_REPO_BADGE_COLOR)
    expect(result).not.toHaveProperty('externalWorktreeVisibility')
  })

  it('drops a same-path negative submodule cache before a local clone', async () => {
    const destination = await createTempRoot()
    const clonePath = join(destination, 'orca')
    let cloned = false
    gitExecFileAsyncMock.mockImplementation((args: string[]) =>
      Promise.resolve({
        stdout:
          args[0] === 'config' && args.includes('.gitmodules') && cloned
            ? 'submodule.lib.path vendor/lib\n'
            : '',
        stderr: ''
      })
    )
    gitSpawnMock.mockImplementationOnce(() => {
      const proc = createMockCloneProcess()
      setImmediate(() => {
        cloned = true
        proc.emit('close', 0, null)
      })
      return proc
    })

    await expect(listSubmodulePaths(clonePath)).resolves.toEqual([])
    await handlers.get('repos:clone')!(null, {
      url: 'https://example.com/orca.git',
      destination
    })
    await expect(listSubmodulePaths(clonePath)).resolves.toEqual(['vendor/lib'])

    const configReads = gitExecFileAsyncMock.mock.calls.filter(
      ([args]) => args[0] === 'config' && args.includes('.gitmodules')
    )
    expect(configReads).toHaveLength(2)
  })

  it('preserves existing badgeColor when repos:clone upgrades folder->git after dedupe', async () => {
    const destination = await createTempRoot()
    const clonePath = join(destination, 'orca')
    const existing = {
      id: 'folder-repo',
      path: clonePath,
      displayName: 'orca',
      badgeColor: '#8b5cf6',
      addedAt: 1,
      kind: 'folder'
    }
    const upgraded = { ...existing, kind: 'git' as const }
    mockStore.getRepos.mockReturnValue([existing])
    mockStore.updateRepo.mockReturnValue(upgraded)

    const result = await handlers.get('repos:clone')!(null, {
      url: 'https://example.com/orca.git',
      destination
    })

    expect(mockStore.updateRepo).toHaveBeenCalledWith(existing.id, {
      kind: 'git',
      projectHostSetupMethod: 'cloned'
    })
    expect(result).toEqual(upgraded)
    expect(result).toHaveProperty('badgeColor', '#8b5cf6')
    expect(prepareLocalWorktreeRootForRepoMock).toHaveBeenCalledWith(mockStore, upgraded)
    expect(invalidateAuthorizedRootsCacheMock).toHaveBeenCalled()
    expect(mockStore.addRepo).not.toHaveBeenCalled()
  })

  it('rejects a dot-segment URL before creating the destination or spawning git', async () => {
    const tempRoot = await createTempRoot()
    const destination = join(tempRoot, 'destination')

    await expect(
      handlers.get('repos:clone')!(null, {
        url: 'file:///tmp/source/.',
        destination
      })
    ).rejects.toThrow('Invalid repository name derived from URL')

    expect(existsSync(destination)).toBe(false)
    expect(gitSpawnMock).not.toHaveBeenCalled()
  })

  it('rejects a parent-segment URL before creating the destination or spawning git', async () => {
    const tempRoot = await createTempRoot()
    const destination = join(tempRoot, 'destination')

    await expect(
      handlers.get('repos:clone')!(null, {
        url: 'file:///tmp/source/..',
        destination
      })
    ).rejects.toThrow('Invalid repository name derived from URL')

    expect(existsSync(destination)).toBe(false)
    expect(gitSpawnMock).not.toHaveBeenCalled()
  })

  it('rejects a relative destination before creating directories or spawning git', async () => {
    const destination = `relative-clone-destination-${Date.now()}`

    await expect(
      handlers.get('repos:clone')!(null, {
        url: 'https://example.com/orca.git',
        destination
      })
    ).rejects.toThrow('Clone destination must be an absolute path')

    expect(existsSync(destination)).toBe(false)
    expect(gitSpawnMock).not.toHaveBeenCalled()
  })

  it('rejects URL-derived names containing Windows separators before spawning git', async () => {
    const destination = await createTempRoot()

    await expect(
      handlers.get('repos:clone')!(null, {
        url: 'https://example.com/team\\orca.git',
        destination
      })
    ).rejects.toThrow('Invalid repository name derived from URL')

    expect(gitSpawnMock).not.toHaveBeenCalled()
  })

  it('accepts Windows local-path clone sources while validating the final segment', async () => {
    const destination = await createTempRoot()

    const result = await handlers.get('repos:clone')!(null, {
      url: 'C:\\src\\orca.git',
      destination
    })

    expect(gitSpawnMock).toHaveBeenCalledWith(
      ['clone', '--progress', '--', 'C:\\src\\orca.git', join(destination, 'orca')],
      expect.objectContaining({ cwd: destination })
    )
    expect(result).toHaveProperty('path', join(destination, 'orca'))
  })

  it('clones with the non-interactive credential guard so Git Credential Manager cannot pop its OAuth window (#7652)', async () => {
    const destination = await createTempRoot()

    await handlers.get('repos:clone')!(null, {
      url: 'https://example.com/orca.git',
      destination
    })

    // Without this env, a clone needing auth makes Git Credential Manager pop and loop its OAuth window on Windows.
    expect(gitSpawnMock).toHaveBeenCalledWith(
      ['clone', '--progress', '--', 'https://example.com/orca.git', join(destination, 'orca')],
      expect.objectContaining({
        env: expect.objectContaining({
          GIT_TERMINAL_PROMPT: '0',
          GCM_INTERACTIVE: 'never'
        })
      })
    )
  })

  it('treats cloneAbort with no active clone as a no-op', async () => {
    await expect(handlers.get('repos:cloneAbort')!(null, undefined)).resolves.toBeUndefined()
  })

  it('cancels a local clone before Git starts when environment readiness is pending', async () => {
    const destination = await createTempRoot()
    const clonePath = join(destination, 'orca')
    gitSpawnAfterWindowsEnvironmentReadyMock.mockImplementation(
      (_args: string[], options: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          const abort = (): void => {
            reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }))
          }
          if (options.signal?.aborted) {
            abort()
          } else {
            options.signal?.addEventListener('abort', abort, { once: true })
          }
        })
    )

    const clonePromise = Promise.resolve(
      handlers.get('repos:clone')!(null, {
        url: 'https://example.com/orca.git',
        destination
      })
    )
    const rejection = expect(clonePromise).rejects.toThrow('Clone failed')
    await waitForAssertion(() =>
      expect(gitSpawnAfterWindowsEnvironmentReadyMock).toHaveBeenCalledOnce()
    )
    expect(gitSpawnMock).not.toHaveBeenCalled()

    await handlers.get('repos:cloneAbort')!(null, undefined)
    await rejection
    expect(gitSpawnMock).not.toHaveBeenCalled()
    expect(existsSync(clonePath)).toBe(false)
  })

  it('cancels every concurrent local clone waiting for environment readiness', async () => {
    const firstDestination = await createTempRoot()
    const secondDestination = await createTempRoot()
    gitSpawnAfterWindowsEnvironmentReadyMock.mockImplementation(
      (_args: string[], options: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          const abort = (): void => {
            reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }))
          }
          if (options.signal?.aborted) {
            abort()
          } else {
            options.signal?.addEventListener('abort', abort, { once: true })
          }
        })
    )

    const firstClone = Promise.resolve(
      handlers.get('repos:clone')!(null, {
        url: 'https://example.com/first.git',
        destination: firstDestination
      })
    )
    const secondClone = Promise.resolve(
      handlers.get('repos:clone')!(null, {
        url: 'https://example.com/second.git',
        destination: secondDestination
      })
    )
    const firstRejection = expect(firstClone).rejects.toThrow('Clone failed')
    const secondRejection = expect(secondClone).rejects.toThrow('Clone failed')
    await waitForAssertion(() =>
      expect(gitSpawnAfterWindowsEnvironmentReadyMock).toHaveBeenCalledTimes(2)
    )

    await handlers.get('repos:cloneAbort')!(null, undefined)

    await Promise.all([firstRejection, secondRejection])
    expect(gitSpawnMock).not.toHaveBeenCalled()
    expect(existsSync(join(firstDestination, 'first'))).toBe(false)
    expect(existsSync(join(secondDestination, 'second'))).toBe(false)
  })

  it('does not remove an existing target directory when aborting a pending clone', async () => {
    const destination = await createTempRoot()
    const clonePath = join(destination, 'orca')
    await mkdir(clonePath)
    await writeFile(join(clonePath, 'user-file.txt'), 'keep me')
    const proc = createMockCloneProcess()
    gitSpawnMock.mockReturnValueOnce(proc)

    const clonePromise = handlers.get('repos:clone')!(null, {
      url: 'https://example.com/orca.git',
      destination
    })
    await waitForAssertion(() => expect(gitSpawnMock).toHaveBeenCalledTimes(1))

    await handlers.get('repos:cloneAbort')!(null, undefined)
    proc.emit('close', null, 'SIGTERM')
    await expect(clonePromise).rejects.toThrow('Clone aborted')

    expect(existsSync(clonePath)).toBe(true)
    expect(existsSync(join(clonePath, 'user-file.txt'))).toBe(true)
  })

  it('does not remove an existing target file when aborting a pending clone', async () => {
    const destination = await createTempRoot()
    const clonePath = join(destination, 'orca')
    await writeFile(clonePath, 'existing file')
    const proc = createMockCloneProcess()
    gitSpawnMock.mockReturnValueOnce(proc)

    const clonePromise = handlers.get('repos:clone')!(null, {
      url: 'https://example.com/orca.git',
      destination
    })
    await waitForAssertion(() => expect(gitSpawnMock).toHaveBeenCalledTimes(1))

    await handlers.get('repos:cloneAbort')!(null, undefined)
    proc.emit('close', null, 'SIGTERM')
    await expect(clonePromise).rejects.toThrow('Clone aborted')

    expect(existsSync(clonePath)).toBe(true)
  })

  it('removes a fresh clone target only after the aborted process closes unsuccessfully', async () => {
    const destination = await createTempRoot()
    const clonePath = join(destination, 'orca')
    const proc = createMockCloneProcess()
    gitSpawnMock.mockReturnValueOnce(proc)

    const clonePromise = handlers.get('repos:clone')!(null, {
      url: 'https://example.com/orca.git',
      destination
    })
    await waitForAssertion(() => expect(gitSpawnMock).toHaveBeenCalledTimes(1))

    await handlers.get('repos:cloneAbort')!(null, undefined)
    expect(existsSync(clonePath)).toBe(true)

    proc.emit('close', null, 'SIGTERM')
    await expect(clonePromise).rejects.toThrow('Clone aborted')
    expect(existsSync(clonePath)).toBe(false)
  })

  it('removes an owned fresh clone target when git exits unsuccessfully', async () => {
    const destination = await createTempRoot()
    const clonePath = join(destination, 'orca')
    const partialFile = join(clonePath, 'partial.txt')
    const proc = createMockCloneProcess()
    gitSpawnMock.mockReturnValueOnce(proc)

    const clonePromise = handlers.get('repos:clone')!(null, {
      url: 'https://example.com/orca.git',
      destination
    })
    await waitForAssertion(() => expect(gitSpawnMock).toHaveBeenCalledTimes(1))
    await writeFile(partialFile, 'git wrote this before failing')

    proc.stderr.emit('data', Buffer.from('fatal: repository not found\n'))
    proc.emit('close', 128, null)
    await expect(clonePromise).rejects.toThrow('Clone failed: fatal: repository not found')

    expect(existsSync(clonePath)).toBe(false)
  })

  it('reports the full fatal clone error when stderr includes progress fragments', async () => {
    const destination = await createTempRoot()
    const proc = createMockCloneProcess()
    gitSpawnMock.mockReturnValueOnce(proc)

    const clonePromise = handlers.get('repos:clone')!(null, {
      url: 'https://example.com/orca.git',
      destination
    })
    await waitForAssertion(() => expect(gitSpawnMock).toHaveBeenCalledTimes(1))

    proc.stderr.emit(
      'data',
      Buffer.from(
        "Cloning into 'orca'...\rfatal: destination path 'orca' already exists and is not an empty directory.\r\nand the repository exists.\n"
      )
    )
    proc.emit('close', 128, null)

    await expect(clonePromise).rejects.toThrow(
      `Clone failed: Destination already exists and is not empty: ${join(
        destination,
        'orca'
      )}. Choose a different parent folder, delete the existing folder, or add the existing repository instead.`
    )
  })

  it('removes an owned fresh clone target when git spawn emits an error', async () => {
    const destination = await createTempRoot()
    const clonePath = join(destination, 'orca')
    const partialFile = join(clonePath, 'partial.txt')
    const proc = createMockCloneProcess()
    gitSpawnMock.mockReturnValueOnce(proc)

    const clonePromise = handlers.get('repos:clone')!(null, {
      url: 'https://example.com/orca.git',
      destination
    })
    await waitForAssertion(() => expect(gitSpawnMock).toHaveBeenCalledTimes(1))
    await writeFile(partialFile, 'git wrote this before spawn failure')

    proc.emit('error', new Error('spawn failed'))
    await expect(clonePromise).rejects.toThrow('Clone failed: spawn failed')

    expect(existsSync(clonePath)).toBe(false)
  })

  it('keeps a fresh clone target when abort races with a successful close', async () => {
    const destination = await createTempRoot()
    const clonePath = join(destination, 'orca')
    const proc = createMockCloneProcess()
    gitSpawnMock.mockReturnValueOnce(proc)

    const clonePromise = handlers.get('repos:clone')!(null, {
      url: 'https://example.com/orca.git',
      destination
    })
    await waitForAssertion(() => expect(gitSpawnMock).toHaveBeenCalledTimes(1))

    await handlers.get('repos:cloneAbort')!(null, undefined)
    proc.emit('close', 0, null)
    await expect(clonePromise).resolves.toMatchObject({
      path: clonePath,
      kind: 'git'
    })

    expect(existsSync(clonePath)).toBe(true)
  })

  it('dedupes retry when abort races with a successful clone close', async () => {
    const destination = await createTempRoot()
    const clonePath = join(destination, 'orca')
    const repos: unknown[] = []
    mockStore.getRepos.mockImplementation(() => repos)
    mockStore.addRepo.mockImplementation((repo: unknown) => {
      repos.push(repo)
    })
    const firstProc = createMockCloneProcess()
    const secondProc = createMockCloneProcess()
    gitSpawnMock.mockReturnValueOnce(firstProc).mockReturnValueOnce(secondProc)

    const firstClonePromise = handlers.get('repos:clone')!(null, {
      url: 'https://example.com/orca.git',
      destination
    })
    await waitForAssertion(() => expect(gitSpawnMock).toHaveBeenCalledTimes(1))

    await handlers.get('repos:cloneAbort')!(null, undefined)
    const secondClonePromise = handlers.get('repos:clone')!(null, {
      url: 'https://example.com/orca.git',
      destination
    })
    await new Promise((resolve) => setImmediate(resolve))
    expect(gitSpawnMock).toHaveBeenCalledTimes(1)

    firstProc.emit('close', 0, null)
    await expect(firstClonePromise).resolves.toMatchObject({ path: clonePath, kind: 'git' })
    await expect(secondClonePromise).resolves.toMatchObject({ path: clonePath, kind: 'git' })

    expect(gitSpawnMock).toHaveBeenCalledTimes(1)
    expect(secondProc.kill).not.toHaveBeenCalled()
  })

  it('serializes concurrent clones for the same target', async () => {
    const destination = await createTempRoot()
    const clonePath = join(destination, 'orca')
    const repos: unknown[] = []
    mockStore.getRepos.mockImplementation(() => repos)
    mockStore.addRepo.mockImplementation((repo: unknown) => {
      repos.push(repo)
    })
    const firstProc = createMockCloneProcess()
    gitSpawnMock.mockReturnValueOnce(firstProc)

    const firstClonePromise = handlers.get('repos:clone')!(null, {
      url: 'https://example.com/orca.git',
      destination
    })
    const secondClonePromise = handlers.get('repos:clone')!(null, {
      url: 'https://example.com/orca.git',
      destination
    })
    await waitForAssertion(() => expect(gitSpawnMock).toHaveBeenCalledTimes(1))

    firstProc.emit('close', 0, null)
    await expect(firstClonePromise).resolves.toMatchObject({ path: clonePath, kind: 'git' })
    await expect(secondClonePromise).resolves.toMatchObject({ path: clonePath, kind: 'git' })

    expect(gitSpawnMock).toHaveBeenCalledTimes(1)
  })

  it('waits for pending abort cleanup before retrying the same clone target', async () => {
    const destination = await createTempRoot()
    const clonePath = join(destination, 'orca')
    const partialFile = join(clonePath, 'partial.txt')
    const firstProc = createMockCloneProcess()
    const secondProc = createMockCloneProcess()
    gitSpawnMock.mockReturnValueOnce(firstProc).mockReturnValueOnce(secondProc)

    const firstClonePromise = handlers.get('repos:clone')!(null, {
      url: 'https://example.com/orca.git',
      destination
    })
    await waitForAssertion(() => expect(gitSpawnMock).toHaveBeenCalledTimes(1))
    await writeFile(partialFile, 'first clone wrote this before abort')
    await handlers.get('repos:cloneAbort')!(null, undefined)

    const secondClonePromise = handlers.get('repos:clone')!(null, {
      url: 'https://example.com/orca.git',
      destination
    })
    await new Promise((resolve) => setImmediate(resolve))
    expect(gitSpawnMock).toHaveBeenCalledTimes(1)
    expect(existsSync(partialFile)).toBe(true)

    firstProc.emit('close', null, 'SIGTERM')
    await expect(firstClonePromise).rejects.toThrow('Clone aborted')
    await waitForAssertion(() => expect(gitSpawnMock).toHaveBeenCalledTimes(2))
    expect(existsSync(partialFile)).toBe(false)

    secondProc.emit('close', 0, null)
    await expect(secondClonePromise).resolves.toMatchObject({
      path: clonePath,
      kind: 'git'
    })
    expect(existsSync(clonePath)).toBe(true)
  })

  it('skips abort cleanup when the claimed target is replaced before close', async () => {
    const destination = await createTempRoot()
    const clonePath = join(destination, 'orca')
    const replacementFile = join(clonePath, 'replacement.txt')
    const proc = createMockCloneProcess()
    gitSpawnMock.mockReturnValueOnce(proc)

    const clonePromise = handlers.get('repos:clone')!(null, {
      url: 'https://example.com/orca.git',
      destination
    })
    await waitForAssertion(() => expect(gitSpawnMock).toHaveBeenCalledTimes(1))

    await handlers.get('repos:cloneAbort')!(null, undefined)
    await rm(clonePath, { recursive: true, force: true })
    await mkdir(clonePath)
    await writeFile(replacementFile, 'new owner')

    proc.emit('close', null, 'SIGTERM')
    await expect(clonePromise).rejects.toThrow('Clone aborted')

    expect(existsSync(replacementFile)).toBe(true)
  })
})
