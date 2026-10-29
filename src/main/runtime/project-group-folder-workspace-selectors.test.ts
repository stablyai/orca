import { tmpdir } from 'node:os'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { withDurableRuntimeStore } from './runtime-durable-store-fixture'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import { folderWorkspaceKey } from '../../shared/workspace-scope'
import { OrcaRuntimeService } from './orca-runtime'
import { setRuntimeBrowserCommandsFactory } from './runtime-browser-commands-factory'

// STA-12562: project-group folder workspaces have no repo row, so a Git-only selector never finds them.
const FOLDER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const WORKSPACE_ID = folderWorkspaceKey(FOLDER_ID)
// Browser workspaces require the folder on disk.
const FOLDER_PATH = tmpdir()

const connectedLinearWorkspaces = vi.hoisted(() => {
  const current: { id: string; organizationUrlKey: string }[] = []
  return { current }
})
vi.mock('../linear/issue-context/client', async (importOriginal) => ({
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

  it('sleeps it (worktree.sleep)', async () => {
    const result = await createRuntime().sleepManagedWorktree(`id:${WORKSPACE_ID}`)

    expect(result.worktreeId).toBe(WORKSPACE_ID)
  })

  it('lists its terminals by its bare workspace key', async () => {
    const listed = await createRuntime().listTerminals(WORKSPACE_ID)

    expect(listed.terminals).toEqual([])
  })

  it('resolves its active terminal instead of rejecting the workspace', async () => {
    await expect(createRuntime().resolveActiveTerminal(`id:${WORKSPACE_ID}`)).rejects.toThrow(
      'no_active_terminal'
    )
  })

  it('reads its stored scrollback instead of rejecting the workspace', async () => {
    await expect(
      createRuntime().readTerminalScrollbackForClient({
        worktree: `id:${WORKSPACE_ID}`,
        ref: `v1-${'0'.repeat(32)}`
      })
    ).rejects.toThrow('terminal_scrollback_not_found')
  })

  it('gives plugins its context while it is the active workspace', async () => {
    const context = await createRuntime(WORKSPACE_ID).resolveActiveWorktreeContext()

    expect(context).toMatchObject({ worktreeId: WORKSPACE_ID, path: FOLDER_PATH })
  })
})

function runtimeWithFolderTerminal(
  linkedTask: Record<string, unknown>,
  setWorktreeMeta?: (...args: unknown[]) => unknown
) {
  const runtime = createRuntime(null, linkedTask, setWorktreeMeta)
  const leafId = '22222222-2222-4222-8222-222222222222'
  runtime.attachWindow(1)
  const handle = runtime.preAllocateHandleForPty('folder-pty')
  runtime.registerPty('folder-pty', WORKSPACE_ID, null, { tabId: 'tab-1', leafId })
  runtime.syncWindowGraph(1, {
    tabs: [
      { tabId: 'tab-1', worktreeId: WORKSPACE_ID, title: '', activeLeafId: leafId, layout: null }
    ],
    leaves: [
      { tabId: 'tab-1', worktreeId: WORKSPACE_ID, leafId, paneRuntimeId: 1, ptyId: 'folder-pty' }
    ]
  })
  return { runtime, handle }
}

const LINKED_LINEAR_TASK = {
  provider: 'linear',
  type: 'issue',
  number: 1,
  title: 'Fix it',
  url: 'https://linear.app/acme/issue/ENG-1',
  linearIdentifier: 'ENG-1'
}

describe('Linear --current from a project-group folder workspace terminal', () => {
  it('reads the folder workspace’s linked Linear issue', async () => {
    const { runtime, handle } = runtimeWithFolderTerminal({
      ...LINKED_LINEAR_TASK,
      linearWorkspaceId: 'linear-workspace-1'
    })

    const link = await runtime.linearCommands.linearResolveCurrentIssue({ terminalHandle: handle })

    expect(link.identifier).toBe('ENG-1')
  })

  it('answers a legacy link without writing worktree metadata for the folder', async () => {
    connectedLinearWorkspaces.current = [{ id: 'linear-workspace-1', organizationUrlKey: 'acme' }]
    const setWorktreeMeta = vi.fn()
    const { runtime, handle } = runtimeWithFolderTerminal(
      { ...LINKED_LINEAR_TASK, linearOrganizationUrlKey: 'acme' },
      setWorktreeMeta
    )

    const link = await runtime.linearCommands.linearResolveCurrentIssue({ terminalHandle: handle })

    expect(link.workspaceId).toBe('linear-workspace-1')
    expect(setWorktreeMeta).not.toHaveBeenCalled()
    connectedLinearWorkspaces.current = []
  })
})

describe('browser commands on a project-group folder workspace', () => {
  beforeAll(async () => {
    // Install browser RPCs as Electron does; plain Node hosts leave them unavailable.
    const { RuntimeBrowserCommands } = await import('./browser/browser-commands')
    setRuntimeBrowserCommandsFactory((host) => new RuntimeBrowserCommands(host))
    return () => setRuntimeBrowserCommandsFactory(null)
  })

  it('lists its browser tabs through the agent browser bridge', async () => {
    const runtime = createRuntime()
    const tabList = vi.fn(() => ({ tabs: [] }))
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: listing reads only these bridge methods.
    runtime.setAgentBrowserBridge({
      tabList,
      getRegisteredTabs: () => new Map(),
      getActivePageId: () => null
    } as never)

    await expect(runtime.browserTabList({ worktree: `id:${WORKSPACE_ID}` })).resolves.toEqual({
      tabs: []
    })
  })
})
