import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as NodeProcess from 'node:process'
import type { Repo } from '../shared/repo-types'
import type { Store } from './persistence'
import type * as WorkspaceSpaceScanBudgetModule from '../shared/workspace-space-scan-budget'

const { budgetState, execFileMock, spawnMock, listRepoWorktreesMock } = vi.hoisted(() => ({
  budgetState: { created: 0, duMaxEntries: null as number | null },
  execFileMock: vi.fn(),
  spawnMock: vi.fn(),
  listRepoWorktreesMock: vi.fn()
}))

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
  spawn: spawnMock
}))

vi.mock('node:process', async () => {
  const actual = await vi.importActual<typeof NodeProcess>('node:process')
  return { ...actual, platform: 'darwin' }
})

vi.mock('./repo-worktrees', () => ({
  createFolderWorktree: (repo: Repo) => ({
    path: repo.path,
    head: '',
    branch: '',
    isBare: false,
    isMainWorktree: true
  }),
  listRepoWorktrees: listRepoWorktreesMock
}))

vi.mock('./providers/ssh-filesystem-dispatch', () => ({
  getSshFilesystemProvider: vi.fn()
}))

vi.mock('./providers/ssh-git-dispatch', () => ({
  getSshGitProvider: vi.fn()
}))

vi.mock('../shared/workspace-space-scan-budget', async () => {
  const actual = await vi.importActual<typeof WorkspaceSpaceScanBudgetModule>(
    '../shared/workspace-space-scan-budget'
  )
  return {
    ...actual,
    createWorkspaceSpaceScanBudget: () => {
      budgetState.created += 1
      return actual.createWorkspaceSpaceScanBudget(
        budgetState.created === 2 && budgetState.duMaxEntries
          ? { maxEntries: budgetState.duMaxEntries }
          : undefined
      )
    }
  }
})

import { analyzeWorkspaceSpace } from './workspace-space-analysis'

function createStore(repos: Repo[]): Store {
  return {
    getRepos: () => repos,
    getWorktreeMeta: () => undefined
  } as unknown as Store
}

describe('analyzeWorkspaceSpace local du timeout', () => {
  let tempDir: string | null = null

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'orca-space-du-timeout-'))
    execFileMock.mockReset()
    spawnMock.mockReset()
    listRepoWorktreesMock.mockReset()
    budgetState.created = 0
    budgetState.duMaxEntries = null
  })

  afterEach(async () => {
    vi.useRealTimers()
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true })
      tempDir = null
    }
  })

  function mockRepo(repoPath: string): Repo {
    const repo: Repo = {
      id: 'repo-1',
      path: repoPath,
      displayName: 'orca',
      badgeColor: '#000',
      addedAt: 0
    }
    listRepoWorktreesMock.mockResolvedValue([
      {
        path: repoPath,
        head: 'a',
        branch: 'refs/heads/main',
        isBare: false,
        isMainWorktree: true
      }
    ])
    return repo
  }

  function createSpawnedDu() {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter
      stderr: EventEmitter
      kill: ReturnType<typeof vi.fn>
    }
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.kill = vi.fn()
    return child
  }

  it('streams native du output instead of using execFile buffering', async () => {
    const repoPath = join(tempDir!, 'repo')
    await mkdir(repoPath, { recursive: true })
    await writeFile(join(repoPath, 'app.ts'), 'console.log("ok")\n')
    const repo = mockRepo(repoPath)
    const child = createSpawnedDu()
    spawnMock.mockReturnValue(child)
    execFileMock.mockImplementation(() => {
      throw new Error('execFile should not be used for workspace Space scans')
    })

    const scanPromise = analyzeWorkspaceSpace(createStore([repo]))

    await vi.waitFor(() =>
      expect(spawnMock).toHaveBeenCalledWith('du', ['-k', '-d', '1', repoPath], {
        stdio: ['ignore', 'pipe', 'pipe']
      })
    )
    child.stdout.emit('data', Buffer.from(`4\t${join(repoPath, 'app.ts')}\n`))
    child.stdout.emit('data', Buffer.from(`12\t${repoPath}`))
    child.stdout.emit('data', Buffer.from('\n'))
    child.emit('close', 0)

    await expect(scanPromise).resolves.toMatchObject({
      scannedWorktreeCount: 1,
      unavailableWorktreeCount: 0,
      worktrees: [
        expect.objectContaining({
          status: 'ok',
          path: repoPath,
          sizeBytes: 12 * 1024
        })
      ]
    })
    expect(execFileMock).not.toHaveBeenCalled()
  })

  it('preserves multibyte du paths split across stdout chunks', async () => {
    const repoPath = join(tempDir!, 'repo')
    const dirname = '数据'
    await mkdir(join(repoPath, dirname), { recursive: true })
    await writeFile(join(repoPath, dirname, 'pkg.js'), Buffer.alloc(128))
    const repo = mockRepo(repoPath)
    const child = createSpawnedDu()
    spawnMock.mockReturnValue(child)

    const scanPromise = analyzeWorkspaceSpace(createStore([repo]))

    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled())
    const dirnameBytes = Buffer.from(dirname)
    const duLine = Buffer.from(`24\t${join(repoPath, dirname)}\n`)
    const splitAt = duLine.indexOf(dirnameBytes) + 1
    child.stdout.emit('data', duLine.subarray(0, splitAt))
    child.stdout.emit('data', duLine.subarray(splitAt))
    child.stdout.emit('data', Buffer.from(`32\t${repoPath}\n`))
    child.emit('close', 0)

    await expect(scanPromise).resolves.toMatchObject({
      worktrees: [
        expect.objectContaining({
          sizeBytes: 32 * 1024,
          topLevelItems: [
            expect.objectContaining({
              name: dirname,
              sizeBytes: 24 * 1024
            })
          ]
        })
      ]
    })
  })

  it('bounds native du with a deadline before releasing the local scan slot', async () => {
    const repoPath = join(tempDir!, 'repo')
    await mkdir(repoPath, { recursive: true })
    await writeFile(join(repoPath, 'app.ts'), 'console.log("ok")\n')
    const repo = mockRepo(repoPath)
    const controller = new AbortController()
    const child = createSpawnedDu()
    spawnMock.mockReturnValue(child)

    vi.useFakeTimers()
    const scanPromise = analyzeWorkspaceSpace(createStore([repo]), { signal: controller.signal })

    await vi.waitFor(() =>
      expect(spawnMock).toHaveBeenCalledWith('du', ['-k', '-d', '1', repoPath], {
        stdio: ['ignore', 'pipe', 'pipe']
      })
    )
    await vi.advanceTimersByTimeAsync(120_000)

    controller.abort()
    await expect(scanPromise).resolves.toMatchObject({
      unavailableWorktreeCount: 1,
      worktrees: [
        expect.objectContaining({
          status: 'unavailable',
          error: 'du timed out after 120000ms'
        })
      ]
    })
    expect(child.kill).toHaveBeenCalled()
  })

  it('fails closed when streamed du rows exceed the retained entry budget', async () => {
    const repoPath = join(tempDir!, 'repo')
    await mkdir(repoPath, { recursive: true })
    await writeFile(join(repoPath, 'app.ts'), 'console.log("ok")\n')
    const repo = mockRepo(repoPath)
    const child = createSpawnedDu()
    spawnMock.mockReturnValue(child)
    budgetState.duMaxEntries = 2

    const scanPromise = analyzeWorkspaceSpace(createStore([repo]))

    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled())
    child.stdout.emit('data', Buffer.from(`1\t${join(repoPath, 'one')}\n`))
    child.stdout.emit('data', Buffer.from(`1\t${join(repoPath, 'two')}\n`))
    child.stdout.emit('data', Buffer.from(`1\t${join(repoPath, 'three')}\n`))
    child.emit('close', 0)

    await expect(scanPromise).resolves.toMatchObject({
      unavailableWorktreeCount: 1,
      worktrees: [expect.objectContaining({ status: 'unavailable' })]
    })
    expect(child.kill).toHaveBeenCalled()
  })

  it('falls back accurately when native du is unavailable', async () => {
    const repoPath = join(tempDir!, 'repo')
    await mkdir(join(repoPath, 'node_modules'), { recursive: true })
    await writeFile(join(repoPath, 'node_modules', 'pkg.js'), Buffer.alloc(512))
    await writeFile(join(repoPath, 'app.ts'), Buffer.alloc(128))
    const repo = mockRepo(repoPath)
    spawnMock.mockImplementation(() => {
      throw Object.assign(new Error('du not found'), { code: 'ENOENT' })
    })

    await expect(analyzeWorkspaceSpace(createStore([repo]))).resolves.toMatchObject({
      scannedWorktreeCount: 1,
      unavailableWorktreeCount: 0,
      worktrees: [
        expect.objectContaining({
          status: 'ok',
          path: repoPath,
          topLevelItems: expect.arrayContaining([
            expect.objectContaining({ name: 'node_modules', sizeBytes: expect.any(Number) }),
            expect.objectContaining({ name: 'app.ts', sizeBytes: 128 })
          ])
        })
      ]
    })
    expect(execFileMock).not.toHaveBeenCalled()
  })

  it('runs one local du traversal at a time across repos', async () => {
    const repoPaths = [join(tempDir!, 'repo-one'), join(tempDir!, 'repo-two')]
    await Promise.all(repoPaths.map((repoPath) => mkdir(repoPath, { recursive: true })))
    const repos: Repo[] = repoPaths.map((repoPath, index) => ({
      id: `repo-${index}`,
      path: repoPath,
      displayName: `repo-${index}`,
      badgeColor: '#000',
      addedAt: 0
    }))
    listRepoWorktreesMock.mockImplementation(async (repo: Repo) => [
      {
        path: repo.path,
        head: 'a',
        branch: 'refs/heads/main',
        isBare: false,
        isMainWorktree: true
      }
    ])
    const completions: (() => void)[] = []
    let active = 0
    let peak = 0
    spawnMock.mockImplementation((_file: string, args: string[]) => {
      const rootPath = args.at(-1)!
      const child = createSpawnedDu()
      active += 1
      peak = Math.max(peak, active)
      completions.push(() => {
        active -= 1
        child.stdout.emit('data', Buffer.from(`1\t${rootPath}\n`))
        child.emit('close', 0)
      })
      return child
    })

    const scan = analyzeWorkspaceSpace(createStore(repos))
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1))
    completions.shift()?.()
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(2))
    completions.shift()?.()

    await expect(scan).resolves.toMatchObject({ scannedWorktreeCount: 2 })
    expect(peak).toBe(1)
  })
})
