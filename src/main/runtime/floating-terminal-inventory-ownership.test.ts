// #23428: a floating serve- PTY whose cwd is inside a folder workspace must stay floating.
import { describe, expect, it, vi } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../shared/constants'

// Fragments stay side-effect ordered: mocks, then lifecycle, then fixtures.
const { OrcaRuntimeService } = await import('./orca-runtime-test-mocks.spec')
await import('./orca-runtime-test-lifecycle.spec')
const { createFolderWorkspaceRuntimeStore, makeFolderProjectGroup, makeFolderWorkspace, store } =
  await import('./orca-runtime-test-fixtures.spec')

const HOME_FOLDER = '/tmp/platform'

function makeRuntime() {
  const folderWorkspace = makeFolderWorkspace({ folderPath: HOME_FOLDER })
  const runtimeStore = {
    ...createFolderWorkspaceRuntimeStore(
      folderWorkspace,
      makeFolderProjectGroup({ parentPath: HOME_FOLDER })
    ),
    getSettings: () => ({ ...store.getSettings(), floatingTerminalCwd: HOME_FOLDER })
  }
  const live = new Set<string>()
  const spawn = vi.fn(async (args: { sessionId?: string }) => {
    const id = args.sessionId ?? 'serve-fallback'
    live.add(id)
    return { id }
  })
  const runtime = new OrcaRuntimeService(runtimeStore)
  runtime.setPtyController({
    spawn,
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    hasPty: (ptyId: string) => live.has(ptyId),
    // The daemon reports no worktree for serve- ids; only the cwd is known.
    listProcesses: async () => [...live].map((id) => ({ id, cwd: HOME_FOLDER, title: 'shell' }))
  })
  runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
  return { runtime, folderWorkspaceKey: `folder:${folderWorkspace.id}` }
}

describe('PTY inventory refresh keeps recorded floating ownership', () => {
  it('does not re-file a floating terminal under the folder workspace containing its cwd', async () => {
    const { runtime, folderWorkspaceKey } = makeRuntime()
    const created = await runtime.createMobileSessionTerminal(
      `id:${FLOATING_TERMINAL_WORKTREE_ID}`,
      {
        activate: false
      }
    )
    expect(created.tab).toMatchObject({ status: 'ready' })

    // A paired desktop lists the folder workspace's tabs, which refreshes inventory scoped to it.
    await runtime.listMobileSessionTabs(`id:${folderWorkspaceKey}`)
    await runtime.listTerminals(`id:${folderWorkspaceKey}`)
    const listed = await runtime.listTerminals()

    const terminal = listed.terminals.find((entry) => entry.ptyId?.startsWith('serve-'))
    expect(terminal?.worktreeId).toBe(FLOATING_TERMINAL_WORKTREE_ID)
    expect(terminal?.worktreeId).not.toBe(folderWorkspaceKey)
    const floating = await runtime.listMobileSessionTabs(`id:${FLOATING_TERMINAL_WORKTREE_ID}`)
    expect(floating.tabs.find((tab) => tab.type === 'terminal')).toMatchObject({
      status: 'ready'
    })
  })
})
