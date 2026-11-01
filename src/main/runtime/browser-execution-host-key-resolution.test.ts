import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { FolderWorkspace } from '../../shared/folder-workspace-types'
import { parseBrowserNetworkExecutionHostKey } from '../browser/browser-network-execution-route'
import { OrcaRuntimeService } from './orca-runtime'

// Use the real resolver: adoption retires missing workspaces but preserves pages awaiting an offline host.
const FOLDER_WORKSPACE_ID = 'folder-workspace-1'
const WORKSPACE_ID = `folder:${FOLDER_WORKSPACE_ID}`

describe('browser execution host key resolution', () => {
  it('resolves a workspace whose execution host is up', async () => {
    const runtime = createRuntime()

    const resolution = await runtime.resolveBrowserExecutionHostKeyForWorkspace(WORKSPACE_ID)

    expect(resolution.status).toBe('resolved')
    expect(
      resolution.status === 'resolved' &&
        parseBrowserNetworkExecutionHostKey(resolution.executionHostKey)
    ).toMatchObject({ kind: 'native', runtimeId: runtime.getRuntimeId() })
  })

  it('holds a resolvable workspace whose execution host cannot be minted yet', async () => {
    const runtime = createRuntime()
    Object.defineProperty(runtime, 'resolveBrowserNetworkExecutionHostForWorktree', {
      value: async () => {
        throw new Error('Host provider is not ready')
      }
    })

    await expect(runtime.resolveBrowserExecutionHostKeyForWorkspace(WORKSPACE_ID)).resolves.toEqual(
      { status: 'unavailable' }
    )
  })

  it('settles a workspace that no longer resolves', async () => {
    const runtime = createRuntime()

    await expect(
      runtime.resolveBrowserExecutionHostKeyForWorkspace('folder:deleted-workspace')
    ).resolves.toEqual({ status: 'workspace-gone' })
  })
})

function createRuntime(overrides: Partial<FolderWorkspace> = {}): OrcaRuntimeService {
  const folderPath = mkdtempSync(join(tmpdir(), 'orca-browser-host-key-'))
  const folderWorkspace: FolderWorkspace = {
    id: FOLDER_WORKSPACE_ID,
    projectGroupId: 'project-group-1',
    name: 'Workspace',
    folderPath,
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 1,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
  return new OrcaRuntimeService({
    getFolderWorkspaces: () => [folderWorkspace],
    getProjectGroups: () => [],
    getAllWorktreeMeta: () => ({}),
    getWorktreeMeta: () => undefined,
    getRepo: () => null,
    getRepos: () => [],
    getSettings: () => ({})
  } as never)
}
