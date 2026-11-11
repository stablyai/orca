import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../../shared/constants'
import { OrcaRuntimeService } from '../../orca-runtime'
import { withDurableRuntimeStore } from '../../orca-runtime-tests/runtime-durable-store-fixture'

const { readFile } = vi.hoisted(() => ({ readFile: vi.fn() }))
vi.mock('../../terminal/output/terminal-kitty-file-read', () => ({
  readTerminalKittyFile: readFile
}))

const PTY = 'kitty-file-pty'
const LEAF = '11111111-1111-4111-8111-111111111111'
const WORKSPACE = 'folder:kitty-files'

// A project-group folder workspace: no repo row backs it, so a Git-only selector never finds it.
function folderWorkspaceStore() {
  const folder = {
    id: 'kitty-files',
    projectGroupId: 'group-1',
    name: 'kitty',
    folderPath: '/workspace',
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
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: fixture supplies only the store reads workspace resolution makes.
  return withDurableRuntimeStore({
    getRepos: () => [],
    getRepo: () => undefined,
    getFolderWorkspaces: () => [folder],
    getAllWorktreeMeta: () => ({}),
    getWorktreeMeta: () => undefined,
    getWorkspaceSession: () => getDefaultWorkspaceSession(),
    setWorkspaceSession: () => {},
    flushOrThrow: () => {}
  }) as never
}

function fixture(ptyId = PTY, connectionId: string | null = null, worktreeId = WORKSPACE) {
  const runtime = new OrcaRuntimeService(folderWorkspaceStore())
  runtime.attachWindow(1)
  const handle = runtime.preAllocateHandleForPty(ptyId)
  runtime.registerPty(ptyId, worktreeId, connectionId, {
    tabId: 'file-tab',
    leafId: LEAF,
    incarnationId: 'file-incarnation'
  })
  runtime.syncWindowGraph(1, {
    tabs: [{ tabId: 'file-tab', worktreeId, title: '', activeLeafId: LEAF, layout: null }],
    leaves: [{ tabId: 'file-tab', worktreeId, leafId: LEAF, paneRuntimeId: 1, ptyId }]
  })
  return { runtime, handle }
}

beforeEach(() => {
  readFile.mockReset().mockResolvedValue({ base64: 'aW1hZ2U=' })
})

describe('Kitty file execution-host ownership', () => {
  it('drops a completed read after the PTY incarnation is replaced', async () => {
    const { runtime, handle } = fixture()
    let release: (result: { base64: string }) => void = () => {
      throw new Error('read did not start')
    }
    readFile.mockImplementation(
      () =>
        new Promise<{ base64: string }>((resolve) => {
          release = resolve
        })
    )
    const pending = runtime.readKittyFile(handle, { path: '/tmp/image' })
    await vi.waitFor(() => expect(readFile).toHaveBeenCalledOnce())
    runtime.registerPty(PTY, WORKSPACE, null, {
      tabId: 'file-tab',
      leafId: LEAF,
      incarnationId: 'new-incarnation'
    })
    release({ base64: 'c3RhbGU=' })
    await expect(pending).rejects.toThrow('terminal_handle_stale')
  })
})
