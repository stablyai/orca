import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DockerEngineInfo } from '../docker/types'
import type { WorktreeMeta } from '../../shared/types'
import { DockerEngineFake } from '../docker/docker-engine-fake'

const { handleMock, removeHandlerMock } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  removeHandlerMock: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: handleMock,
    removeHandler: removeHandlerMock
  }
}))

import { clearDockerEngineStatusCache, registerDockerIpcHandlers } from './docker'

type Handler = (_event: unknown, args?: unknown) => unknown

const availableEngine: DockerEngineInfo = {
  available: true,
  flavor: 'colima',
  socketPath: '/tmp/docker.sock'
}

function makeStore(repoOverrides: Record<string, unknown> = {}) {
  return {
    getRepo: vi.fn().mockReturnValue({
      id: 'repo-1',
      path: '/repo',
      displayName: 'Repo',
      badgeColor: '#000',
      addedAt: 0,
      ...repoOverrides
    }),
    setWorktreeMeta: vi
      .fn()
      .mockImplementation((_worktreeId: string, meta: Partial<WorktreeMeta>) => meta)
  }
}

describe('registerDockerIpcHandlers', () => {
  const handlers = new Map<string, Handler>()
  const mainWindow = {
    isDestroyed: () => false,
    webContents: { send: vi.fn() }
  }

  beforeEach(() => {
    handlers.clear()
    handleMock.mockReset()
    removeHandlerMock.mockReset()
    mainWindow.webContents.send.mockReset()
    clearDockerEngineStatusCache()
    handleMock.mockImplementation((channel: string, handler: Handler) => {
      handlers.set(channel, handler)
    })
  })

  it('returns cached Docker engine status for 30 seconds', () => {
    let now = 1_000
    const detectEngine = vi.fn().mockReturnValue(availableEngine)
    registerDockerIpcHandlers(mainWindow as never, makeStore() as never, {
      detectEngine,
      now: () => now
    })

    expect(handlers.get('docker:engine-status')!(null)).toEqual({
      available: true,
      flavor: 'colima'
    })
    now += 10_000
    expect(handlers.get('docker:engine-status')!(null)).toEqual({
      available: true,
      flavor: 'colima'
    })

    expect(detectEngine).toHaveBeenCalledTimes(1)
  })

  it('builds an image and emits progress for the target worktree', async () => {
    const store = makeStore()
    const listWorktrees = vi.fn().mockResolvedValue([
      {
        path: '/repo/wt',
        head: 'abc123',
        branch: 'feature',
        isBare: false,
        isMainWorktree: false
      }
    ])
    const buildImage = vi.fn().mockResolvedValue({
      id: 'image-1',
      cacheKey: 'cache-1',
      dockerfilePath: '/repo/.devcontainer/Dockerfile',
      builtAt: 123
    })
    registerDockerIpcHandlers(mainWindow as never, store as never, {
      detectEngine: () => availableEngine,
      buildImage,
      createEngineClient: () => ({ buildImage: vi.fn() }) as never,
      listWorktrees
    })

    const result = await handlers.get('docker:build-image')!(null, {
      repoId: 'repo-1',
      worktreeId: 'repo-1::/repo/wt'
    })

    expect(result).toEqual(expect.objectContaining({ id: 'image-1' }))
    expect(buildImage).toHaveBeenCalledWith(
      expect.objectContaining({
        repoPath: '/repo/wt',
        repoIdentity: 'repo-1'
      })
    )
    expect(mainWindow.webContents.send).toHaveBeenCalledWith(
      'docker:build-progress',
      expect.objectContaining({ worktreeId: 'repo-1::/repo/wt', phase: 'pull' })
    )
    expect(mainWindow.webContents.send).toHaveBeenCalledWith(
      'docker:build-progress',
      expect.objectContaining({ worktreeId: 'repo-1::/repo/wt', phase: 'ready', percent: 100 })
    )
  })

  it('rejects image builds when Docker is unavailable and emits failed progress', async () => {
    const listWorktrees = vi.fn().mockResolvedValue([
      {
        path: '/repo/wt',
        head: 'abc123',
        branch: 'feature',
        isBare: false,
        isMainWorktree: false
      }
    ])
    const buildImage = vi.fn()
    registerDockerIpcHandlers(mainWindow as never, makeStore() as never, {
      detectEngine: () => ({
        available: false,
        flavor: 'docker-engine-linux',
        socketPath: '',
        reason: 'Docker daemon is not running'
      }),
      buildImage,
      listWorktrees
    })

    await expect(
      handlers.get('docker:build-image')!(null, {
        repoId: 'repo-1',
        worktreeId: 'repo-1::/repo/wt'
      })
    ).rejects.toThrow('Docker daemon is not running')

    expect(buildImage).not.toHaveBeenCalled()
    expect(mainWindow.webContents.send).toHaveBeenCalledWith('docker:build-progress', {
      worktreeId: 'repo-1::/repo/wt',
      phase: 'failed',
      error: 'Docker daemon is not running'
    })
  })

  it('rejects image builds when the worktree id is not known for the repo', async () => {
    const buildImage = vi.fn()
    const detectEngine = vi.fn().mockReturnValue(availableEngine)
    registerDockerIpcHandlers(mainWindow as never, makeStore() as never, {
      detectEngine,
      buildImage,
      listWorktrees: vi.fn().mockResolvedValue([
        {
          path: '/repo/other',
          head: 'abc123',
          branch: 'other',
          isBare: false,
          isMainWorktree: false
        }
      ])
    })

    const result = await handlers.get('docker:build-image')!(null, {
      repoId: 'repo-1',
      worktreeId: 'repo-1::/repo/wt'
    })

    expect(result).toEqual({
      error: 'Docker image builds must target a known worktree for this repo.'
    })
    expect(detectEngine).not.toHaveBeenCalled()
    expect(buildImage).not.toHaveBeenCalled()
    expect(mainWindow.webContents.send).not.toHaveBeenCalled()
  })

  it('rejects Docker image builds for SSH repositories', async () => {
    const store = makeStore({ connectionId: 'ssh-1', path: '/home/user/project' })
    const buildImage = vi.fn()
    const detectEngine = vi.fn().mockReturnValue(availableEngine)
    registerDockerIpcHandlers(mainWindow as never, store as never, {
      detectEngine,
      buildImage,
      createEngineClient: () => ({ buildImage: vi.fn() }) as never
    })

    const result = await handlers.get('docker:build-image')!(null, {
      repoId: 'repo-1',
      worktreeId: 'repo-1::/home/user/project'
    })

    expect(result).toEqual({
      error:
        'Docker isolation is not yet supported for SSH repositories. Use a local repo or remove the SSH connection.'
    })
    expect(detectEngine).not.toHaveBeenCalled()
    expect(buildImage).not.toHaveBeenCalled()
    expect(mainWindow.webContents.send).not.toHaveBeenCalled()
  })

  it('persists worktree isolation in the settings store', () => {
    const store = makeStore()
    registerDockerIpcHandlers(mainWindow as never, store as never)

    const result = handlers.get('docker:set-worktree-isolation')!(null, {
      worktreeId: 'repo-1::/repo/wt',
      isolation: 'docker'
    })

    expect(store.setWorktreeMeta).toHaveBeenCalledWith('repo-1::/repo/wt', {
      isolation: 'docker'
    })
    expect(result).toEqual({ isolation: 'docker' })
  })

  it('lists Orca cached Docker images', async () => {
    const engine = new DockerEngineFake()
    engine.imageList = [
      { id: 'sha256:image-1', repository: 'orca-worktree', tag: 'abc123', size: '12MB' }
    ]
    engine.imageInspect.set('sha256:image-1', {
      id: 'sha256:image-1',
      repoTags: ['orca-worktree:cache-key-12345678901234'],
      labels: {
        orca: 'true',
        'orca.cache-key': 'cache-key-12345678901234567890',
        'orca.dockerfile-path': '/repo/.devcontainer/Dockerfile'
      },
      sizeBytes: 1234
    })
    registerDockerIpcHandlers(mainWindow as never, makeStore() as never, {
      createEngineClient: () => engine
    })

    await expect(handlers.get('docker:list-cached-images')!(null)).resolves.toEqual([
      {
        id: 'sha256:image-1',
        cacheKey: 'cache-key-12345678901234567890',
        dockerfilePath: '/repo/.devcontainer/Dockerfile',
        sizeBytes: 1234,
        lastUsedAt: 0
      }
    ])
    expect(engine.commands[0]).toEqual({
      command: 'image.list',
      options: { label: 'orca' }
    })
  })

  it('prunes only Orca-tagged images', async () => {
    const engine = new DockerEngineFake()
    engine.imageInspect.set('sha256:image-1', {
      id: 'sha256:image-1',
      repoTags: ['orca-worktree:cache-key-12345678901234'],
      labels: {
        orca: 'true',
        'orca.cache-key': 'cache-key-12345678901234567890'
      },
      sizeBytes: 1234
    })
    registerDockerIpcHandlers(mainWindow as never, makeStore() as never, {
      createEngineClient: () => engine
    })

    await handlers.get('docker:prune-image')!(null, 'sha256:image-1')

    expect(engine.commands).toEqual(
      expect.arrayContaining([{ command: 'image.rm', id: 'sha256:image-1' }])
    )
  })

  it('rejects pruning images without Orca labels and tags', async () => {
    const engine = new DockerEngineFake()
    engine.imageInspect.set('sha256:image-1', {
      id: 'sha256:image-1',
      repoTags: ['ubuntu:latest'],
      labels: {},
      sizeBytes: 1234
    })
    registerDockerIpcHandlers(mainWindow as never, makeStore() as never, {
      createEngineClient: () => engine
    })

    await expect(handlers.get('docker:prune-image')!(null, 'sha256:image-1')).rejects.toThrow(
      'Refusing to prune a non-Orca Docker image'
    )
  })
})
