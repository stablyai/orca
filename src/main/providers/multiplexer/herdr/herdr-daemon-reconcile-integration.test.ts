import { afterEach, describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync, readFileSync } from 'node:fs'
import type { IPty } from 'node-pty'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { Store } from '../../../persistence'
import { HerdrTransport } from './herdr-transport'
import { HerdrDaemon } from './herdr-daemon-class'
import { HerdrDaemonHostTransport } from './herdr-daemon-host-transport'
import { HerdrPtyProvider } from './herdr-pty-provider'
import { HerdrRuntimeManager } from './herdr-runtime-manager'
import { herdrSessionNameForProject } from '../../../../shared/herdr-session-identity'
import { createLocalHerdrPtyTargetResolver } from './herdr-project-pty-target'
import { orcaPaneBinding } from './herdr-binding-metadata'
import { unwrapHerdrResponse } from './herdr-runtime-contract'
import type { HerdrProjectHostGraph } from './herdr-runtime-graph'
import { restoreHerdrTestDataDir, setHerdrTestDataDir } from './herdr-daemon-test-env'

type DataListener = (data: string) => void
type ExitListener = (event: { exitCode: number; signal?: number }) => void

// Why: this test exercises the exact production path that crashed with
// "Cannot read properties of undefined (reading 'workspace_id')": the runtime
// manager reconciling a project host graph against the in-app daemon through
// the daemon host transport. Real PTYs are replaced by fakes so the test does
// not depend on host pty allocation.
function fakePty(): IPty {
  const dataListeners = new Set<DataListener>()
  const exitListeners = new Set<ExitListener>()
  return {
    pid: 9999,
    cols: 80,
    rows: 24,
    process: '/bin/bash',
    handleFlowControl: false,
    onData: (listener: DataListener) => {
      dataListeners.add(listener)
      return { dispose: () => dataListeners.delete(listener) }
    },
    onExit: (listener: ExitListener) => {
      exitListeners.add(listener)
      return { dispose: () => exitListeners.delete(listener) }
    },
    resize: vi.fn(),
    clear: vi.fn(),
    write: vi.fn(),
    kill: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    spawn: vi.fn()
  } as unknown as IPty
}

const proto = HerdrDaemon.prototype as unknown as Record<'spawnPty', unknown>
const realSpawnPty = proto.spawnPty
const spawnedPtys: IPty[] = []

function makeTab(id: string): TerminalTab {
  return {
    id,
    ptyId: null,
    worktreeId: 'repo-1::/tmp/ws',
    title: 'Main',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1,
    startupCwd: '/tmp/ws'
  }
}

function graph(): HerdrProjectHostGraph {
  const project = {
    id: 'project-1',
    displayName: 'Test Project',
    badgeColor: '#000000',
    sourceRepoIds: [],
    createdAt: 1,
    updatedAt: 1
  }
  const tab = makeTab('tab-1')
  return {
    project,
    worktrees: [{ id: 'repo-1::/tmp/ws', path: '/tmp/ws', displayName: 'ws' }],
    tabsByWorktreeId: {
      'repo-1::/tmp/ws': [tab]
    },
    layoutsByTabId: {
      'tab-1': {
        root: {
          type: 'split',
          direction: 'horizontal',
          ratio: 0.5,
          first: { type: 'leaf', leafId: 'leaf-1' },
          second: { type: 'leaf', leafId: 'leaf-2' }
        },
        activeLeafId: 'leaf-1',
        expandedLeafId: null
      }
    }
  }
}

describe('herdr daemon reconcile integration (manager -> host transport -> daemon)', () => {
  const originalHome = process.env.HOME
  const originalHerdrDataDir = process.env.HERDR_DATA_DIR
  let server: HerdrTransport | null = null
  let daemon: HerdrDaemon | null = null
  let transport: HerdrDaemonHostTransport | null = null

  async function setup(): Promise<string> {
    const dir = mkdtempSync(join(tmpdir(), 'herdr-reconcile-test-'))
    const socketPath = join(dir, 'herdr.sock')
    process.env.HOME = dir
    setHerdrTestDataDir(dir)
    spawnedPtys.length = 0
    proto.spawnPty = (() => {
      const pty = fakePty()
      spawnedPtys.push(pty)
      return pty
    }) as never
    server = new HerdrTransport(socketPath)
    server.on('error', () => {})
    daemon = new HerdrDaemon(server)
    await server.startServer()
    transport = new HerdrDaemonHostTransport(socketPath)
    return socketPath
  }

  afterEach(async () => {
    process.env.HOME = originalHome
    restoreHerdrTestDataDir(originalHerdrDataDir)
    // Why: server.close() only completes once client connections end.
    await transport?.disconnect()
    transport = null
    await daemon?.dispose()
    daemon = null
    await server?.close()
    server = null
    proto.spawnPty = realSpawnPty
  })

  it('reconciles a split layout end to end and resolves pane bindings', async () => {
    await setup()
    const manager = new HerdrRuntimeManager(transport!, () => undefined)

    await transport!.ensureSession('orca')
    await manager.reconcileProjectHost(graph())

    const sessionName = herdrSessionNameForProject(graph().project)
    const firstPane = manager.getPaneId(sessionName, 'project-1', 'leaf-1')
    const secondPane = manager.getPaneId(sessionName, 'project-1', 'leaf-2')
    expect(firstPane).toBeTruthy()
    expect(secondPane).toBeTruthy()
    expect(firstPane).not.toBe(secondPane)

    // Reconcile again: idempotent, same bindings.
    await manager.reconcileProjectHost(graph())
    expect(manager.getPaneId(sessionName, 'project-1', 'leaf-1')).toBe(firstPane)

    // controlProjectPane resolves a live controller for each bound leaf.
    const controller = await manager.controlProjectPane(graph().project, 'leaf-1', {
      cols: 100,
      rows: 40
    })
    expect(controller).toBeDefined()
    controller.release()
  })

  it('materializes a pane for a leaf the reconcile did not bind', async () => {
    await setup()
    const manager = new HerdrRuntimeManager(transport!, () => undefined)
    await transport!.ensureSession('orca')
    await manager.reconcileProjectHost(graph())

    const sessionName = herdrSessionNameForProject(graph().project)
    const paneId = await manager.materializeLeafPane(graph().project, 'leaf-fresh', '/tmp/ws', 'ws')
    expect(paneId).toBeTruthy()
    expect(manager.getPaneId(sessionName, 'project-1', 'leaf-fresh')).toBe(paneId)

    const controller = await manager.controlProjectPane(graph().project, 'leaf-fresh', {
      cols: 80,
      rows: 24
    })
    expect(controller).toBeDefined()
    controller.release()
  })

  it('reclaims a stale-token pane when a tab has no untagged root pane', async () => {
    await setup()
    const manager = new HerdrRuntimeManager(transport!, () => undefined)
    await transport!.ensureSession('orca')
    await manager.reconcileProjectHost(graph())

    // Stain EVERY pane of the layout tab with stale leaf tokens, simulating a
    // previous broken run leaving no untagged pane to adopt.
    const sessionName = herdrSessionNameForProject(graph().project)
    const session = unwrapHerdrResponse<{
      snapshot: { panes: { pane_id: string; tab_id: string }[] }
    }>(await transport!.request(sessionName, 'session.snapshot', {}))
    const layoutPaneIds = session.snapshot.panes
      .filter((pane) => pane.tab_id !== 't1')
      .map((pane) => pane.pane_id)
    for (const paneId of layoutPaneIds) {
      await transport!.request(sessionName, 'pane.report_metadata', {
        pane_id: paneId,
        tokens: { orca_binding: orcaPaneBinding('project-1', 'leaf-stale') }
      })
    }

    const nextGraph: HerdrProjectHostGraph = {
      ...graph(),
      layoutsByTabId: {
        'tab-1': {
          root: { type: 'leaf' as const, leafId: 'leaf-9' },
          activeLeafId: 'leaf-9',
          expandedLeafId: null
        }
      }
    }
    await manager.reconcileProjectHost(nextGraph)

    const reclaimed = manager.getPaneId(sessionName, 'project-1', 'leaf-9')
    expect(reclaimed).toBeTruthy()
    expect(layoutPaneIds).toContain(reclaimed)
  })

  it('persists pane binding tokens so a restart reattaches the same pane ids', async () => {
    await setup()
    const manager = new HerdrRuntimeManager(transport!, () => undefined)
    await transport!.ensureSession('orca')
    await manager.reconcileProjectHost(graph())

    const sessionName = herdrSessionNameForProject(graph().project)
    const firstPane = manager.getPaneId(sessionName, 'project-1', 'leaf-1')

    // Force the debounced save and read the persisted state directly.
    await new Promise((resolve) => setTimeout(resolve, 1300))
    const state = JSON.parse(
      readFileSync(join(process.env.HOME!, '.local/share/herdr/sessions/orca/session.json'), 'utf8')
    )
    const savedPane = state.panes.find((pane: { pane_id: string }) => pane.pane_id === firstPane)
    expect(savedPane).toBeDefined()
    expect(savedPane.tokens?.orca_binding).toBeTruthy()
  })

  it('materializes a pane for legacy adoption resolved from persisted identity only', async () => {
    await setup()
    const store = {
      getSettings: () => ({ terminalBackendDefault: 'herdr' }),
      getProjects: () => [],
      getRepo: () => undefined,
      getWorktreeMeta: () => undefined,
      getWorkspaceSession: () => ({ tabsByWorktree: {}, terminalLayoutsByTabId: {} })
    } as unknown as Store

    const target = await createLocalHerdrPtyTargetResolver(store)(
      { cols: 80, rows: 24, cwd: '/tmp/wt', sessionId: 'legacy-worker-pty-id' },
      {
        hostId: 'local',
        projectId: 'project-1',
        worktreeId: 'repo-1::/tmp/wt',
        tabId: 'tab-9',
        leafId: 'leaf-9'
      }
    )
    expect(target).not.toBeNull()

    const manager = new HerdrRuntimeManager(transport!, () => undefined)
    await transport!.ensureSession('orca')
    await manager.reconcileProjectHost(target!.graph)

    const sessionName = herdrSessionNameForProject(target!.project)
    expect(manager.getPaneId(sessionName, target!.project.id, 'leaf-9')).toBeTruthy()

    const controller = await manager.controlProjectPane(target!.project, 'leaf-9', {
      cols: 80,
      rows: 24
    })
    expect(controller).toBeDefined()
    controller.release()
  })

  it('delivers renderer input to the pane PTY and applies absolute resizes', async () => {
    await setup()
    const store = {
      getSettings: () => ({ terminalBackendDefault: 'herdr' }),
      getProjects: () => [],
      getRepo: () => undefined,
      getWorktreeMeta: () => undefined,
      getWorkspaceSession: () => ({ tabsByWorktree: {}, terminalLayoutsByTabId: {} })
    } as unknown as Store
    const resolver = createLocalHerdrPtyTargetResolver(store)

    const provider = new HerdrPtyProvider(
      () => transport!,
      resolver,
      () => undefined
    )
    const spawned = await provider.spawn({
      cols: 100,
      rows: 40,
      cwd: '/tmp/wt',
      worktreeId: 'repo-1::/tmp/wt',
      tabId: 'tab-1',
      paneKey: 'tab-1:leaf-1'
    })
    expect(spawned.id).toBeTruthy()

    provider.write(spawned.id, 'echo hello\r')
    await new Promise((resolve) => setTimeout(resolve, 50))

    const writeMock = spawnedPtys.at(-1)!.write as ReturnType<typeof vi.fn>
    expect(
      writeMock.mock.calls.some(([data]) => typeof data === 'string' && data.includes('echo hello'))
    ).toBe(true)

    provider.resize(spawned.id, 132, 43)
    await new Promise((resolve) => setTimeout(resolve, 50))

    const resizeMock = spawnedPtys.at(-1)!.resize as ReturnType<typeof vi.fn>
    expect(resizeMock.mock.calls.some(([cols, rows]) => cols === 132 && rows === 43)).toBe(true)
  })
})
