import { describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import { parsePtySessionId } from '../../shared/terminal/pty/lifecycle/pty-session-id-format'
import { withBoundPane } from './orca-runtime-tests/bind-first-pane.test-fixture'

// Preserve side-effect order: mocks, lifecycle, fixtures.
await import('./orca-runtime-tests/runtime-test-module-registration.spec')
const { OrcaRuntimeService } = await import('./orca-runtime')
await import('./orca-runtime-tests/orca-runtime-test-lifecycle.spec')
const { createFolderWorkspaceRuntimeStore, makeFolderProjectGroup, makeFolderWorkspace } =
  await import('./orca-runtime-tests/orca-runtime-test-fixtures.spec')

const FOLDER = process.cwd()
const H = '10000000-0000-4000-8000-000000000001'
const B = '10000000-0000-4000-8000-000000000002'

// Same-path folder workspaces on a headless serve host (#36716).
function makeServeHost(seed: { ptyId: string; worktreeId?: string }[] = []) {
  const folders = [H, B].map((id) => makeFolderWorkspace({ id, folderPath: FOLDER }))
  let session = getDefaultWorkspaceSession()
  for (const [index, { ptyId, worktreeId }] of seed.entries()) {
    if (worktreeId) {
      session = withBoundPane(session, {
        worktreeId,
        tabId: `tab-${index}`,
        leafId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        ptyId
      })
    }
  }
  const store = {
    ...createFolderWorkspaceRuntimeStore(
      folders[0],
      makeFolderProjectGroup({ parentPath: FOLDER })
    ),
    getFolderWorkspaces: () => folders,
    getWorkspaceSession: () => session,
    setWorkspaceSession: (next: typeof session) => {
      session = next
    },
    flushOrThrow: () => {}
  }
  const live = new Set(seed.map(({ ptyId }) => ptyId))
  const runtime = new OrcaRuntimeService(store)
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
    // Like the daemon, report only the workspace a session id names; every shell shares one cwd.
    listProcesses: async () =>
      [...live].map((id) => {
        const { worktreeId } = parsePtySessionId(id)
        return {
          id,
          incarnationId: `${id}-incarnation`,
          terminalHandle: `term_${id}`,
          wslDistro: null,
          cwd: FOLDER,
          title: 'shell',
          ...(worktreeId ? { worktreeId } : {})
        }
      })
  })
  runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
  const ownerOf = async (ptyId: string) =>
    (await runtime.listTerminals()).terminals.find((entry) => entry.ptyId === ptyId)?.worktreeId
  return { runtime, spawn, stopAndWait, live, ownerOf }
}

describe('serve host terminal workspace ownership', () => {
  it('keeps a paired client terminal in its workspace when a same-path sibling refreshes', async () => {
    const { runtime, spawn, stopAndWait, live, ownerOf } = makeServeHost()
    await runtime.createMobileSessionTerminal(`id:folder:${H}`, { activate: false })
    const spawned = await spawn.mock.results.at(-1)?.value
    const id = spawned?.id ?? ''
    expect(id).toMatch(new RegExp(`^folder:${H}@@serve-`))

    await runtime.listMobileSessionTabs(`id:folder:${B}`)
    expect((await runtime.listTerminals(`id:folder:${B}`)).terminals).toEqual([])
    expect(await ownerOf(id)).toBe(`folder:${H}`)

    await runtime.stopTerminalsForWorktree(`id:folder:${B}`)
    expect(stopAndWait).not.toHaveBeenCalled()
    expect(live.has(id)).toBe(true)
  })

  it('keeps a restored workspace-less serve terminal with its persisted binding', async () => {
    const legacy = 'serve-00000000-0000-4000-8000-0000000000aa'
    const { runtime, stopAndWait, live, ownerOf } = makeServeHost([
      { ptyId: legacy, worktreeId: `folder:${H}` }
    ])

    await runtime.listMobileSessionTabs(`id:folder:${B}`)
    expect((await runtime.listTerminals(`id:folder:${B}`)).terminals).toEqual([])
    expect(await ownerOf(legacy)).toBe(`folder:${H}`)

    await runtime.stopTerminalsForWorktree(`id:folder:${B}`)
    expect(stopAndWait).not.toHaveBeenCalled()
    expect(live.has(legacy)).toBe(true)
  })

  it('never stops an unbound terminal that a workspace only claims by cwd', async () => {
    const unbound = 'unbound-shell'
    const { runtime, stopAndWait, live } = makeServeHost([{ ptyId: unbound }])

    await runtime.listMobileSessionTabs(`id:folder:${B}`)
    const listed = await runtime.listTerminals(`id:folder:${B}`)
    expect(listed.terminals.map((entry) => entry.ptyId)).toEqual([unbound])

    await runtime.stopTerminalsForWorktree(`id:folder:${B}`)
    await runtime.sleepTerminalsForWorktree(`id:folder:${B}`)
    expect(stopAndWait).not.toHaveBeenCalled()
    expect(live.has(unbound)).toBe(true)
  })

  it('stops a cwd-filed terminal with its workspace once a pane adopts it', async () => {
    const orphan = 'unbound-shell'
    const { runtime, stopAndWait, live } = makeServeHost([{ ptyId: orphan }])
    const before = await runtime.listTerminals(`id:folder:${B}`)

    await runtime.adoptTerminalOrphans({
      worktree: `id:folder:${B}`,
      expectedTopologyRevision: before.topologyRevisions?.[`folder:${B}`] ?? 0,
      claims: [
        {
          terminal: `term_${orphan}`,
          ptyId: orphan,
          incarnationId: `${orphan}-incarnation`,
          tabId: 'adopted-tab',
          leafId: '00000000-0000-4000-8000-0000000000ad'
        }
      ]
    })
    await runtime.stopTerminalsForWorktree(`id:folder:${B}`)

    expect(stopAndWait).toHaveBeenCalledWith(orphan)
    expect(live.has(orphan)).toBe(false)
  })
})
