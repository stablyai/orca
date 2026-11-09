import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'

import { withDurableRuntimeStore } from '../orca-runtime-tests/runtime-durable-store-fixture'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import { OrcaRuntimeService } from '../orca-runtime'

// STA-12562: project-group folder workspaces have no repo row, so a Git-only selector never finds them.
const FOLDER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const WORKSPACE_ID = folderWorkspaceKey(FOLDER_ID)
// Browser workspaces require the folder on disk.
const FOLDER_PATH = tmpdir()

const connectedLinearWorkspaces = vi.hoisted(() => {
  const current: { id: string; organizationUrlKey: string }[] = []
  return { current }
})
vi.mock('../../linear/issue-context/client', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getConnectedWorkspaces: () => connectedLinearWorkspaces.current
}))

function createRuntime(
  activeWorktreeId: string | null = null,
  linkedTask: Record<string, unknown> | null = null,
  setWorktreeMeta: (...args: unknown[]) => unknown = () => ({})
) {
  const folder = {
    id: FOLDER_ID,
    projectGroupId: 'group-1',
    name: 'home',
    folderPath: FOLDER_PATH,
    linkedTask,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 1,
    createdAt: 1,
    updatedAt: 1
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: fixture supplies only the store reads these commands make.
  const store = withDurableRuntimeStore({
    getRepos: () => [],
    getRepo: () => undefined,
    getProjectGroups: () => [
      { id: 'group-1', name: 'Home', parentPath: FOLDER_PATH, connectionId: null }
    ],
    getFolderWorkspaces: () => [folder],
    getAllWorktreeMeta: () => ({}),
    getWorktreeMeta: () => undefined,
    setWorktreeMeta,
    getWorkspaceSession: () => ({ ...getDefaultWorkspaceSession(), activeWorktreeId }),
    setWorkspaceSession: () => {},
    readTerminalScrollbackSnapshotAsync: async () => null,
    statTerminalScrollbackSnapshotSize: async () => null,
    flushOrThrow: () => {}
  }) as never
  const runtime = new OrcaRuntimeService(store)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fake implements only the controller calls these commands make.
  runtime.setPtyController({
    write: () => true,
    kill: () => true,
    stopAndWait: async () => true,
    getForegroundProcess: async () => null,
    listProcesses: async () => []
  } as never)
  return runtime
}

describe('workspace commands on a project-group folder workspace', () => {
  it('shows it (orca worktree show)', async () => {
    const shown = await createRuntime().showManagedWorktree(`id:${WORKSPACE_ID}`)

    expect(shown.id).toBe(WORKSPACE_ID)
    expect(shown.path).toBe(FOLDER_PATH)
  })
})
