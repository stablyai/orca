import { describe, expect, it, vi } from 'vitest'
import { deleteFolderWorkspaceRow } from './folder-workspace-deletion'
import type { RuntimeProjectGroupDependencies } from './runtime-project-group-contract'
import type { RuntimeStore } from '../construction/runtime-store-contract'

function createDeps(args: {
  folderWorkspaceId: string
  botFolderWorkspaceId?: string
  botGroupFolderWorkspaceId?: string
}) {
  const removeFolderWorkspace = vi.fn(() => true)
  const rawStore = {
    getFolderWorkspaces: () => [
      {
        id: args.folderWorkspaceId,
        projectGroupId: 'group-1',
        name: 'Home',
        folderPath: '/tmp/home'
      }
    ],
    getProjectGroups: () => [],
    getBots: () =>
      args.botFolderWorkspaceId
        ? [{ id: 'bot-1', folderWorkspaceId: args.botFolderWorkspaceId }]
        : [],
    getWorkspaceSessionHostIds: () => [],
    removeFolderWorkspace
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Minimal test double implementing only the RuntimeStore methods read by deleteFolderWorkspaceRow.
  const store = rawStore as unknown as RuntimeStore

  const deps: RuntimeProjectGroupDependencies = {
    getStore: () => store,
    resolveRepo: vi.fn(),
    notifyReposChanged: vi.fn(),
    resolveFolderConnectionId: () => null,
    teardownFolderWorkspacePtys: vi.fn(async () => undefined),
    acquireFileWatcherRemoval: vi.fn(async () => ({ finish: async () => undefined })),
    cleanupRemovedFolderWorkspaceState: vi.fn(),
    emitWorktreeLifecycle: vi.fn(),
    isBotGroupHome: (id) => id === args.botGroupFolderWorkspaceId
  }
  return { deps, removeFolderWorkspace }
}

describe('deleteFolderWorkspaceRow bot home guard', () => {
  it('refuses direct deletion of a bot home folder workspace', async () => {
    const { deps, removeFolderWorkspace } = createDeps({
      folderWorkspaceId: 'fw-bot',
      botFolderWorkspaceId: 'fw-bot'
    })
    await expect(deleteFolderWorkspaceRow(deps, 'fw-bot', {})).rejects.toThrow(
      'Cannot delete a bot home folder workspace directly. Delete the bot instead.'
    )
    expect(removeFolderWorkspace).not.toHaveBeenCalled()
  })

  it('refuses direct deletion of a bot group home folder workspace', async () => {
    const { deps, removeFolderWorkspace } = createDeps({
      folderWorkspaceId: 'fw-group',
      botGroupFolderWorkspaceId: 'fw-group'
    })
    await expect(deleteFolderWorkspaceRow(deps, 'fw-group', {})).rejects.toThrow(
      'Cannot delete a bot group home folder workspace directly. Delete the bot group instead.'
    )
    expect(removeFolderWorkspace).not.toHaveBeenCalled()
  })

  it('allows internal bot teardown with allowBotHome', async () => {
    const { deps, removeFolderWorkspace } = createDeps({
      folderWorkspaceId: 'fw-bot',
      botFolderWorkspaceId: 'fw-bot'
    })
    await expect(
      deleteFolderWorkspaceRow(deps, 'fw-bot', { allowBotHome: true, discardUnsavedDrafts: true })
    ).resolves.toEqual({ deleted: true })
    expect(removeFolderWorkspace).toHaveBeenCalledWith('fw-bot')
  })
})
