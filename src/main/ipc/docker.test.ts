import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DockerEngineInfo } from '../docker/types'
import type { WorktreeMeta } from '../../shared/types'

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

function makeStore() {
  return {
    getRepo: vi.fn().mockReturnValue({
      id: 'repo-1',
      path: '/repo',
      displayName: 'Repo',
      badgeColor: '#000',
      addedAt: 0
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
    const buildImage = vi.fn().mockResolvedValue({
      id: 'image-1',
      cacheKey: 'cache-1',
      dockerfilePath: '/repo/.devcontainer/Dockerfile',
      builtAt: 123
    })
    registerDockerIpcHandlers(mainWindow as never, store as never, {
      detectEngine: () => availableEngine,
      buildImage,
      createEngineClient: () => ({ buildImage: vi.fn() }) as never
    })

    const result = await handlers.get('docker:build-image')!(null, {
      repoId: 'repo-1',
      worktreeId: 'repo-1::/repo/wt'
    })

    expect(result).toEqual(expect.objectContaining({ id: 'image-1' }))
    expect(buildImage).toHaveBeenCalledWith(
      expect.objectContaining({
        repoPath: '/repo',
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
})
