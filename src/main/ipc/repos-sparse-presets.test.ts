import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as CryptoModule from 'crypto'
import type { SparsePreset } from '../../shared/types'

const { handleMock, randomUUIDMock, mockStore } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  randomUUIDMock: vi.fn(() => 'preset-new'),
  mockStore: {
    getRepos: vi.fn().mockReturnValue([]),
    addRepo: vi.fn(),
    removeRepo: vi.fn(),
    getRepo: vi.fn(),
    updateRepo: vi.fn(),
    getSparsePresets: vi.fn(),
    saveSparsePreset: vi.fn(),
    removeSparsePreset: vi.fn()
  }
}))

vi.mock('crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof CryptoModule>()
  return {
    ...actual,
    randomUUID: randomUUIDMock
  }
})

vi.mock('electron', () => ({
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: {
    handle: handleMock,
    removeHandler: vi.fn()
  }
}))

vi.mock('../git/repo', () => ({
  isGitRepo: vi.fn().mockReturnValue(true),
  getGitUsername: vi.fn().mockReturnValue(''),
  getRepoName: vi.fn().mockImplementation((path: string) => path.split('/').pop()),
  getBaseRefDefault: vi.fn().mockResolvedValue('origin/main'),
  searchBaseRefs: vi.fn().mockResolvedValue([]),
  BASE_REF_SEARCH_ARGS: ['for-each-ref'],
  filterBaseRefSearchOutput: vi.fn().mockReturnValue([])
}))

vi.mock('./filesystem-auth', () => ({
  rebuildAuthorizedRootsCache: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('../providers/ssh-git-dispatch', () => ({
  getSshGitProvider: vi.fn()
}))

vi.mock('./ssh', () => ({
  getActiveMultiplexer: vi.fn()
}))

import { registerRepoHandlers } from './repos'

type HandlerMap = Map<string, (_event: unknown, args: unknown) => unknown>

function makePreset(
  overrides: Partial<SparsePreset> & { id: string; repoId: string }
): SparsePreset {
  return {
    name: overrides.id,
    directories: ['packages/web'],
    createdAt: 10,
    updatedAt: 20,
    ...overrides
  }
}

describe('sparse preset repo IPC handlers', () => {
  const handlers: HandlerMap = new Map()
  const mainWindow = {
    isDestroyed: () => false,
    webContents: { send: vi.fn() }
  }

  beforeEach(() => {
    handlers.clear()
    handleMock.mockReset()
    handleMock.mockImplementation((channel: string, handler: (...a: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    })
    randomUUIDMock.mockReturnValue('preset-new')
    mainWindow.webContents.send.mockReset()
    mockStore.getRepo.mockReset().mockReturnValue({
      id: 'repo-1',
      path: '/repo',
      displayName: 'repo',
      badgeColor: '#000',
      addedAt: 0
    })
    mockStore.getSparsePresets.mockReset().mockReturnValue([])
    mockStore.saveSparsePreset.mockReset().mockImplementation((preset: SparsePreset) => preset)
    mockStore.removeSparsePreset.mockReset()

    registerRepoHandlers(mainWindow as never, mockStore as never)
  })

  it('normalizes and de-duplicates saved sparse preset directories', () => {
    const saved = handlers.get('sparsePresets:save')!(null, {
      repoId: 'repo-1',
      name: '  Web preset  ',
      directories: [' packages/web ', 'apps\\api\\', 'packages/web/', '.', '']
    })

    expect(mockStore.saveSparsePreset).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'preset-new',
        repoId: 'repo-1',
        name: 'Web preset',
        directories: ['packages/web', 'apps/api']
      })
    )
    expect(saved).toEqual(
      expect.objectContaining({
        name: 'Web preset',
        directories: ['packages/web', 'apps/api']
      })
    )
    expect(mainWindow.webContents.send).toHaveBeenCalledWith('sparsePresets:changed', {
      repoId: 'repo-1'
    })
  })

  it('preserves createdAt and id when editing an existing preset', () => {
    mockStore.getSparsePresets.mockReturnValue([
      makePreset({ id: 'preset-1', repoId: 'repo-1', name: 'Old', createdAt: 123 })
    ])

    const saved = handlers.get('sparsePresets:save')!(null, {
      repoId: 'repo-1',
      id: 'preset-1',
      name: 'New',
      directories: ['packages/new']
    })

    expect(saved).toEqual(
      expect.objectContaining({
        id: 'preset-1',
        name: 'New',
        createdAt: 123,
        directories: ['packages/new']
      })
    )
  })

  it('rejects invalid sparse preset saves before persistence', () => {
    expect(() =>
      handlers.get('sparsePresets:save')!(null, {
        repoId: 'repo-1',
        name: 'Web',
        directories: ['../secrets']
      })
    ).toThrow('Preset directories must be repo-relative paths.')

    expect(() =>
      handlers.get('sparsePresets:save')!(null, {
        repoId: 'repo-1',
        name: '   ',
        directories: ['packages/web']
      })
    ).toThrow('Preset name is required.')

    expect(() =>
      handlers.get('sparsePresets:save')!(null, {
        repoId: 'repo-1',
        name: 'Web',
        directories: ['.', '']
      })
    ).toThrow('Preset must have at least one directory.')

    expect(mockStore.saveSparsePreset).not.toHaveBeenCalled()
  })

  it.each([
    '/Users/me/repo/packages/web',
    'C:\\repo\\packages\\web',
    '\\\\server\\share\\repo',
    '\\repo\\packages\\web'
  ])('rejects absolute sparse preset directory before normalization: %s', (directory) => {
    expect(() =>
      handlers.get('sparsePresets:save')!(null, {
        repoId: 'repo-1',
        name: 'Web',
        directories: ['packages/web', directory]
      })
    ).toThrow('Preset directories must be repo-relative paths.')

    expect(mockStore.saveSparsePreset).not.toHaveBeenCalled()
  })

  it('rejects sparse preset saves for unknown repos', () => {
    mockStore.getRepo.mockReturnValue(null)

    expect(() =>
      handlers.get('sparsePresets:save')!(null, {
        repoId: 'missing',
        name: 'Web',
        directories: ['packages/web']
      })
    ).toThrow('Repo "missing" not found')
  })

  it('rejects sparse preset removals for unknown repos before persistence', () => {
    mockStore.getRepo.mockReturnValue(null)

    expect(() =>
      handlers.get('sparsePresets:remove')!(null, {
        repoId: 'missing',
        presetId: 'preset-1'
      })
    ).toThrow('Repo "missing" not found')

    expect(mockStore.removeSparsePreset).not.toHaveBeenCalled()
    expect(mainWindow.webContents.send).not.toHaveBeenCalledWith('sparsePresets:changed', {
      repoId: 'missing'
    })
  })
})
