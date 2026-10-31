import { describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import { withBoundPane } from './bind-first-pane.test-fixture'

// Preserve side-effect order: mocks, lifecycle, fixtures.
const { OrcaRuntimeService } = await import('./orca-runtime-test-mocks.spec')
await import('./orca-runtime-test-lifecycle.spec')
const { createFolderWorkspaceRuntimeStore, makeFolderProjectGroup, makeFolderWorkspace } =
  await import('./orca-runtime-test-fixtures.spec')

const FOLDER = process.cwd()
const A = '10000000-0000-4000-8000-000000000001'
const B = '10000000-0000-4000-8000-000000000002'

function makeRuntime() {
  const folders = [A, B].map((id) => makeFolderWorkspace({ id, folderPath: FOLDER }))
  let session = getDefaultWorkspaceSession()
  const runtimeStore = {
    ...createFolderWorkspaceRuntimeStore(
      folders[0],
      makeFolderProjectGroup({ parentPath: FOLDER })
    ),
    getFolderWorkspaces: () => folders,
    getWorkspaceSession: () => session,
    setWorkspaceSession: (next: typeof session) => {
      session = next
    }
  }
  const live = new Set<string>()
  const runtime = new OrcaRuntimeService(runtimeStore)
  const spawn = vi.fn(
    async (args: {
      sessionId?: string
      worktreeId?: string
      tabId?: string
      leafId?: string
      persistHostSessionBinding?: boolean
    }) => {
      if (!args.worktreeId || !args.tabId || !args.leafId) {
        throw new Error('missing identity')
      }
      const id = args.sessionId ?? `${args.worktreeId}@@control`
      live.add(id)
      if (args.persistHostSessionBinding) {
        session = withBoundPane(session, {
          worktreeId: args.worktreeId,
          tabId: args.tabId,
          leafId: args.leafId,
          ptyId: id
        })
      }
      return { id }
    }
  )
  const stopAndWait = vi.fn(async (id: string) => {
    live.delete(id)
    runtime.onPtyExit(id, 0)
    return true
  })
  runtime.setPtyController({
    spawn,
    stopAndWait,
    write: () => true,
    kill: () => true,
    hasPty: (id: string) => live.has(id),
    getForegroundProcess: async () => null,
    listProcesses: async () => [...live].map((id) => ({ id, cwd: FOLDER, title: 'shell' }))
  })
  runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
  const create = async (workspace: string) => {
    const created = await runtime.createMobileSessionTerminal(`id:folder:${workspace}`, {
      activate: false
    })
    expect(created.tab).toMatchObject({ status: 'ready' })
    const result = await spawn.mock.results.at(-1)?.value
    if (!result) {
      throw new Error('terminal was not spawned')
    }
    expect(result.id).toMatch(/^serve-/)
    return result.id
  }
  return { runtime, create, stopAndWait, live }
}

describe('persisted folder terminal ownership during targeted inventory', () => {
  it.each([false, true])('retains a sibling owner with warm catalog=%s', async (warmCatalog) => {
    const { runtime, create } = makeRuntime()
    const id = await create(A)
    const control = await runtime.createTerminal(`id:folder:${A}`, { focus: false })
    expect(control.ptyId).toMatch(/^folder:/)
    if (warmCatalog) {
      await runtime.listTerminals()
    }

    await runtime.listMobileSessionTabs(`id:folder:${B}`)
    const b = await runtime.listTerminals(`id:folder:${B}`)
    expect(b.terminals.map((entry) => entry.ptyId)).not.toContain(id)
    const all = await runtime.listTerminals()
    for (const ptyId of [id, control.ptyId]) {
      expect(all.terminals.find((entry) => entry.ptyId === ptyId)?.worktreeId).toBe(`folder:${A}`)
    }
    await runtime.listMobileSessionTabs(`id:folder:${A}`)
    await runtime.listMobileSessionTabs(`id:folder:${B}`)
    expect(
      (await runtime.listTerminals()).terminals.find((entry) => entry.ptyId === id)?.worktreeId
    ).toBe(`folder:${A}`)
  })

  it('stops only the selected sibling after refreshing its session tabs', async () => {
    const { runtime, create, stopAndWait, live } = makeRuntime()
    const a = await create(A)
    const b = await create(B)

    await runtime.listMobileSessionTabs(`id:folder:${B}`)
    await runtime.stopTerminalsForWorktree(`id:folder:${B}`)

    expect(stopAndWait.mock.calls.map(([id]) => id)).toEqual([b])
    expect(live.has(a)).toBe(true)
    expect(live.has(b)).toBe(false)
  })
})
