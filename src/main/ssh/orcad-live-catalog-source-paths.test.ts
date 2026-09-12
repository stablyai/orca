import { beforeEach, expect, it, vi } from 'vitest'
import { createLiveCatalogSource } from './orcad-live-catalog-source-fixture'
import { createLocalLiveCatalogPaths } from './orcad-live-catalog-paths-fixture'

vi.mock('./orcad-live-catalog-paths-fixture', () => ({ createLocalLiveCatalogPaths: vi.fn() }))

beforeEach(() => vi.clearAllMocks())

it.each([true, false])('uses host-owned catalog paths when supplied=%s', async (remote) => {
  const paths = {
    repoPath: '/host/repo',
    worktreePath: '/host/worktree',
    folderPath: '/host/folder'
  }
  vi.mocked(createLocalLiveCatalogPaths).mockResolvedValue(paths)
  const addRepo = vi.fn()
  const createFolderWorkspace = vi.fn(() => {
    throw new Error('fixture_stop_after_path_registration')
  })
  const options = {
    directory: '/host',
    ...(remote ? { paths } : {}),
    targetId: 'host-target',
    store: {
      createProjectGroup: vi.fn(() => ({ id: 'group' })),
      addRepo,
      createFolderWorkspace
    }
  } as unknown as Parameters<typeof createLiveCatalogSource>[0]
  await expect(createLiveCatalogSource(options)).rejects.toThrow(
    'fixture_stop_after_path_registration'
  )
  if (remote) {
    expect(createLocalLiveCatalogPaths).not.toHaveBeenCalled()
  } else {
    expect(createLocalLiveCatalogPaths).toHaveBeenCalledExactlyOnceWith('/host')
  }
  expect(addRepo).toHaveBeenCalledWith(
    expect.objectContaining({
      path: paths.repoPath,
      connectionId: 'host-target',
      executionHostId: 'ssh:host-target'
    })
  )
  expect(createFolderWorkspace).toHaveBeenCalledWith(
    expect.objectContaining({
      folderPath: paths.folderPath,
      connectionId: 'host-target'
    })
  )
})
