import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { FolderWorkspace } from '../../shared/folder-workspace-types'
import { parseBrowserNetworkExecutionHostKey } from '../browser/browser-network-execution-route'
import { OrcaRuntimeService } from './orca-runtime'

// Why the real service: every other suite stubs this resolver, and its two failure branches are
// what adoption reads as "retire this page" versus "wait for its host". Stubbing the seam that
// decides destruction proves only that the caller obeys the answer, never that the answer is right.
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
    // A workspace pinned to a runtime environment that is not up: the workspace is still there,
    // so its pages must survive until the host comes back.
    const runtime = createRuntime({ executionHostId: 'runtime:environment-1' })

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
