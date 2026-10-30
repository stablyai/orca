import { describe, expect, it } from 'vitest'
import { withDurableRuntimeStore } from './runtime-durable-store-fixture'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import { folderWorkspaceKey } from '../../shared/workspace-scope'
import { OrcaRuntimeService } from './orca-runtime'

// STA-12562: project-group folder workspaces have no repo row, so a repo-only selector never finds them.
const FOLDER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const WORKSPACE_ID = folderWorkspaceKey(FOLDER_ID)
const PTY_ID = `${WORKSPACE_ID}@@pty-a`

function createRuntime() {
  const group = { id: 'group-1', name: 'Home', parentPath: '/Users/me', connectionId: null }
  const folder = {
    id: FOLDER_ID,
    projectGroupId: group.id,
    name: 'home',
    folderPath: '/Users/me',
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 1,
    createdAt: 1,
    updatedAt: 1
  }
  const meta: Record<string, Record<string, unknown>> = {}
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: fixture supplies the store methods sleep reads.
  const store = withDurableRuntimeStore({
    getRepos: () => [],
    getRepo: () => undefined,
    getProjectGroups: () => [group],
    getFolderWorkspaces: () => [folder],
    getAllWorktreeMeta: () => meta,
    getWorktreeMeta: (id: string) => meta[id],
    setWorktreeMeta: () => ({}),
    getWorkspaceSession: () => getDefaultWorkspaceSession(),
    setWorkspaceSession: () => {},
    flushOrThrow: () => {}
  }) as never
  const runtime = new OrcaRuntimeService(store)
  const processLists = [
    [{ id: PTY_ID, worktreeId: WORKSPACE_ID, cwd: '/Users/me', title: 'a' }],
    []
  ]
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fake implements only the controller calls sleep makes.
  runtime.setPtyController({
    write: () => true,
    kill: () => true,
    stopAndWait: async (ptyId: string) => {
      runtime.onPtyExit(ptyId, -1)
      return true
    },
    getForegroundProcess: async () => null,
    listProcesses: async () => processLists.shift() ?? []
  } as never)
  return runtime
}

describe('sleeping a project-group folder workspace', () => {
  it('stops its terminals instead of failing to resolve the workspace', async () => {
    const runtime = createRuntime()

    const result = await runtime.sleepTerminalsForWorktree(`id:${WORKSPACE_ID}`)

    expect(result.stoppedPtyIds).toEqual([PTY_ID])
    expect(result.postStopVerified).toBe(true)
  })
})
