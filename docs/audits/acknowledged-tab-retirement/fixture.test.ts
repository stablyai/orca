import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../../../src/main/persistence/loading-store/store'
import {
  createTestStore,
  seedStore,
  makeWorktree
} from '../../../src/renderer/src/store/slices/store-test-helpers'
import { createStoreCascadesMockApi } from '../../../src/renderer/src/store/slices/store-cascades-test-harness'
import { buildWorkspaceSessionPayload } from '../../../src/renderer/src/lib/workspace-session'
import { buildHeadlessMobileSessionTerminalTabs } from '../../../src/main/runtime/mobile-session-terminal-projection'
import { setRuntimeDesktopSurface } from '../../../src/main/runtime/runtime-desktop-surface'
import { OrcaRuntimeService } from '../../../src/main/runtime/orca-runtime'
import { advanceTerminalTopologyRevision } from '../../../src/main/runtime/workspace-session-terminal-membership-authority'
import type { ExecutionHostId } from '../../../src/shared/execution-host'

class AuditRuntime extends OrcaRuntimeService {
  surfaceParents(worktree: string) {
    return (
      this.mobileSessionTabsByWorktree
        .get(worktree)
        ?.tabs.flatMap((t) => (t.type === 'terminal' ? [t.parentTabId] : [])) ?? []
    )
  }
}
const TAB = '11111111-1111-4111-8111-111111111111'
const LEAF = '22222222-2222-4222-8222-222222222222'
const LEAF_B = '44444444-4444-4444-8444-444444444444'
const INC = '33333333-3333-4333-8333-333333333333'
const INC_B = '55555555-5555-4555-8555-555555555555'
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const fn of cleanup.splice(0)) {
    await fn()
  }
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  setRuntimeDesktopSurface(null)
})
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}
function fixture(kind: 'repo' | 'folder' = 'repo', host: ExecutionHostId = 'local', bound = false) {
  const api = createStoreCascadesMockApi()
  const dir = mkdtempSync(join(tmpdir(), 'orca-close-ack-'))
  const file = join(dir, 'orca-data.json')
  const main = new Store({ dataFile: file })
  const renderer = createTestStore()
  seedStore(renderer, {})
  const repo = { ...renderer.getState().repos[0], executionHostId: host }
  main.addRepo(repo)
  let worktree = `${repo.id}::/tmp/worktree`
  let folder
  if (kind === 'folder') {
    const group = main.createProjectGroup({
      name: 'Folder',
      parentPath: '/tmp/folder',
      createdFrom: 'manual'
    })
    folder = main.createFolderWorkspace({
      projectGroupId: group.id,
      folderPath: '/tmp/folder',
      connectionId: host === 'ssh:target' ? 'target' : null
    })
    folder = main.getFolderWorkspace(folder.id)!
    worktree = `folder:${folder.id}`
  }
  seedStore(renderer, {
    repos: [repo],
    activeRepoId: repo.id,
    activeWorktreeId: worktree,
    activeTabId: TAB,
    worktreesByRepo: {
      [repo.id]: [makeWorktree({ id: worktree, repoId: repo.id, path: '/tmp/worktree' })]
    },
    ...(folder ? { folderWorkspaces: [folder] } : {}),
    tabsByWorktree: { [worktree]: [] }
  })
  renderer.getState().createTab(worktree, undefined, undefined, { id: TAB, activate: false })
  if (bound) {
    renderer.setState((state) => ({
      tabsByWorktree: {
        [worktree]: state.tabsByWorktree[worktree].map((row) => ({ ...row, ptyId: 'pty-a' }))
      },
      terminalLayoutsByTabId: {
        [TAB]: {
          root: {
            type: 'split',
            direction: 'horizontal',
            ratio: 0.5,
            first: { type: 'leaf', leafId: LEAF },
            second: { type: 'leaf', leafId: LEAF_B }
          },
          activeLeafId: LEAF,
          expandedLeafId: null,
          ptyIdsByLeafId: { [LEAF]: 'pty-a', [LEAF_B]: 'pty-b' }
        }
      }
    }))
  }
  const initial = {
    ...buildWorkspaceSessionPayload(renderer.getState()),
    ...(bound
      ? {
          terminalPtyIncarnationsByPaneKey: { [`${TAB}:${LEAF}`]: INC, [`${TAB}:${LEAF_B}`]: INC_B }
        }
      : {})
  }
  main.setWorkspaceSession(initial, host)
  if (host !== 'local') {
    main.setWorkspaceSession(initial, 'local')
  }
  setRuntimeDesktopSurface({
    showNotification: () => false,
    findWindowById: () => {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this proof only reads window and WebContents destruction.
      return { isDestroyed: () => false, webContents: { isDestroyed: () => false } } as never
    },
    onIpc: () => {},
    removeIpcListener: () => {}
  })
  const runtime = new AuditRuntime(main)
  runtime.attachWindow(1)
  if (bound) {
    runtime.registerPty('pty-a', worktree, null, { tabId: TAB, leafId: LEAF, incarnationId: INC })
    runtime.registerPty('pty-b', worktree, null, {
      tabId: TAB,
      leafId: LEAF_B,
      incarnationId: INC_B
    })
  }
  const publish = (present: boolean, version: number) => {
    const session = main.getWorkspaceSession(host)
    const tabs = present
      ? buildHeadlessMobileSessionTerminalTabs(
          worktree,
          session.tabsByWorktree[worktree] ?? [],
          session
        )
      : []
    const graph = {
      tabs: present
        ? [{ tabId: TAB, worktreeId: worktree, title: 'Target', activeLeafId: null, layout: null }]
        : [],
      leaves: [],
      mobileSessionTabs: [
        {
          worktree,
          publicationEpoch: 'renderer:ack',
          activeGroupId: null,
          snapshotVersion: version,
          activeTabId: tabs[0]?.id ?? null,
          activeTabType: tabs.length ? ('terminal' as const) : null,
          tabs
        }
      ]
    }
    runtime.syncWindowGraph(1, graph)
    return graph
  }
  const initialGraph = publish(true, 1)
  main.setWorkspaceSession(
    advanceTerminalTopologyRevision(main.getWorkspaceSession(host), worktree),
    host
  )
  const gate = deferred()
  const entered = deferred()
  const closeTerminalTab = vi.fn(async () => {
    renderer.getState().closeTab(TAB)
    main.setWorkspaceSession(buildWorkspaceSessionPayload(renderer.getState()), host)
    main.flushOrThrow()
    entered.resolve()
    await gate.promise
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this proof exercises only the terminal-close notifier ports.
  runtime.setNotifier({ closeTerminalTab, closeTerminal: () => {} } as never)
  cleanup.push(async () => {
    runtime.setNotifier(null)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [], mobileSessionTabs: [] })
    main.flush()
    main.freezeWrites()
    await main.waitForPendingWrite()
    rmSync(dir, { recursive: true, force: true })
  })
  const hasTab = () =>
    main.getWorkspaceSession(host).tabsByWorktree[worktree]?.some((t) => t.id === TAB) ?? false
  const change = (
    update: (
      session: ReturnType<Store['getWorkspaceSession']>
    ) => ReturnType<Store['getWorkspaceSession']>
  ) =>
    main.setWorkspaceSession(
      advanceTerminalTopologyRevision(update(main.getWorkspaceSession(host)), worktree),
      host
    )
  return {
    api,
    main,
    renderer,
    runtime,
    worktree,
    host,
    file,
    publish,
    initialGraph,
    gate,
    entered,
    hasTab,
    change,
    closeTerminalTab
  }
}

for (const kind of ['repo', 'folder'] as const) {
  for (const host of ['local', 'ssh:target'] as const) {
    it(`durably commits acknowledged close for ${kind}/${host} before graph removal`, async () => {
      const f = fixture(kind, host)
      const pending = f.runtime.closeMobileSessionTab(`id:${f.worktree}`, TAB, { reason: 'user' })
      await expect.poll(() => f.closeTerminalTab.mock.calls.length, { timeout: 2000 }).toBe(1)
      await f.entered.promise
      expect(f.hasTab()).toBe(true)
      f.gate.resolve()
      await expect(pending).resolves.toEqual({ closed: true })
      expect(f.hasTab()).toBe(false)
      // A queued stale renderer save/graph cannot restore durable host membership.
      f.main.setWorkspaceSession(
        {
          ...buildWorkspaceSessionPayload(f.renderer.getState()),
          tabsByWorktree: {
            [f.worktree]: [
              {
                id: TAB,
                worktreeId: f.worktree,
                ptyId: null,
                title: 'Old',
                customTitle: null,
                color: null,
                createdAt: 1,
                sortOrder: 0
              }
            ]
          }
        },
        host
      )
      f.runtime.syncWindowGraph(1, {
        ...f.initialGraph,
        mobileSessionTabs: f.initialGraph.mobileSessionTabs.map((s) => ({
          ...s,
          snapshotVersion: 2
        }))
      })
      expect(f.hasTab()).toBe(false)
      f.publish(false, 3)
      f.main.flushOrThrow()
      const restarted = new Store({ dataFile: f.file })
      expect(
        restarted.getWorkspaceSession(host).tabsByWorktree[f.worktree]?.some((t) => t.id === TAB) ??
          false
      ).toBe(false)
      if (host !== 'local') {
        expect(
          restarted
            .getWorkspaceSession('local')
            .tabsByWorktree[f.worktree].some((t) => t.id === TAB)
        ).toBe(true)
      }
      restarted.flush()
      expect(f.api.pty.kill).not.toHaveBeenCalled()
    })
  }
}
for (const mutation of ['createdAt', 'generation', 'binding', 'leaf', 'incarnation'] as const) {
  it(`preserves ${mutation} replacement while acknowledgement is pending`, async () => {
    const f = fixture()
    const pending = f.runtime.closeMobileSessionTab(`id:${f.worktree}`, TAB, { reason: 'user' })
    await expect.poll(() => f.closeTerminalTab.mock.calls.length, { timeout: 2000 }).toBe(1)
    await f.entered.promise
    f.change((session) => ({
      ...session,
      tabsByWorktree: {
        ...session.tabsByWorktree,
        [f.worktree]: session.tabsByWorktree[f.worktree].map((row) => ({
          ...row,
          ...(mutation === 'createdAt' ? { createdAt: row.createdAt + 1 } : {}),
          ...(mutation === 'generation' ? { generation: 1 } : {}),
          ...(mutation === 'binding' ? { ptyId: 'replacement' } : {})
        }))
      },
      ...(mutation === 'leaf' || mutation === 'incarnation'
        ? {
            terminalLayoutsByTabId: {
              ...session.terminalLayoutsByTabId,
              [TAB]: {
                root: { type: 'leaf', leafId: LEAF },
                activeLeafId: LEAF,
                expandedLeafId: null,
                ptyIdsByLeafId: { [LEAF]: 'replacement' }
              }
            }
          }
        : {}),
      ...(mutation === 'incarnation'
        ? {
            terminalPtyIncarnationsByPaneKey: {
              [`${TAB}:${LEAF}`]: '33333333-3333-4333-8333-333333333333'
            }
          }
        : {})
    }))
    f.gate.resolve()
    await expect(pending).resolves.toMatchObject({
      closed: true,
      refused: true,
      refusalReason: 'stale-terminal'
    })
    expect(f.hasTab()).toBe(true)
    expect(f.api.pty.kill).not.toHaveBeenCalled()
  })
}
it('keeps current pin guard after renderer acknowledges', async () => {
  const f = fixture()
  const pending = f.runtime.closeMobileSessionTab(`id:${f.worktree}`, TAB, { reason: 'user' })
  await expect.poll(() => f.closeTerminalTab.mock.calls.length, { timeout: 2000 }).toBe(1)
  await f.entered.promise
  f.change((s) => ({
    ...s,
    tabsByWorktree: {
      ...s.tabsByWorktree,
      [f.worktree]: s.tabsByWorktree[f.worktree].map((t) => ({ ...t, isPinned: true }))
    }
  }))
  f.gate.resolve()
  await expect(pending).rejects.toThrow('terminal_tab_pinned')
  expect(f.hasTab()).toBe(true)
})
it('does not confuse title/color metadata with replacement', async () => {
  const f = fixture()
  const pending = f.runtime.closeMobileSessionTab(`id:${f.worktree}`, TAB, { reason: 'user' })
  await expect.poll(() => f.closeTerminalTab.mock.calls.length, { timeout: 2000 }).toBe(1)
  await f.entered.promise
  f.change((s) => ({
    ...s,
    tabsByWorktree: {
      ...s.tabsByWorktree,
      [f.worktree]: s.tabsByWorktree[f.worktree].map((t) => ({
        ...t,
        title: 'Updated',
        customTitle: 'Renamed',
        color: 'blue'
      }))
    }
  }))
  f.gate.resolve()
  await expect(pending).resolves.toEqual({ closed: true })
  expect(f.hasTab()).toBe(false)
})

it('finishes durable close after physical exit retires only one original split leaf', async () => {
  const f = fixture('repo', 'local', true)
  const pending = f.runtime.closeMobileSessionTab(`id:${f.worktree}`, TAB, { reason: 'user' })
  await expect.poll(() => f.closeTerminalTab.mock.calls.length, { timeout: 2000 }).toBe(1)
  await f.entered.promise
  f.runtime.onPtyExit('pty-a', 0, INC, { providerExitObserved: true })
  expect(f.main.getWorkspaceSession().terminalLayoutsByTabId[TAB].ptyIdsByLeafId).toEqual({
    [LEAF_B]: 'pty-b'
  })
  f.gate.resolve()
  await expect(pending).resolves.toEqual({ closed: true })
  expect(f.hasTab()).toBe(false)
})
it('preserves registered same-ID successor even after old snapshot was removed', async () => {
  const f = fixture('repo', 'local', true)
  const pending = f.runtime.closeMobileSessionTab(`id:${f.worktree}`, TAB, { reason: 'user' })
  await expect.poll(() => f.closeTerminalTab.mock.calls.length, { timeout: 2000 }).toBe(1)
  await f.entered.promise
  f.publish(false, 2)
  f.runtime.onPtySpawned('pty-a', '66666666-6666-4666-8666-666666666666')
  f.gate.resolve()
  await expect(pending).resolves.toMatchObject({ refused: true, refusalReason: 'stale-terminal' })
  expect(f.hasTab()).toBe(true)
})

it('leaves direct null-PTY renderer close outside the acknowledged-host scope', () => {
  const f = fixture()
  f.renderer.getState().closeTab(TAB)
  f.main.setWorkspaceSession(buildWorkspaceSessionPayload(f.renderer.getState()))
  expect(f.hasTab()).toBe(true)
  expect(f.closeTerminalTab).not.toHaveBeenCalled()
  expect(f.api.pty.kill).not.toHaveBeenCalled()
})
it('does not durably retire when the renderer rejects its close request', async () => {
  const f = fixture()
  f.closeTerminalTab.mockRejectedValueOnce(new Error('terminal_tab_pinned'))
  await expect(
    f.runtime.closeMobileSessionTab(`id:${f.worktree}`, TAB, { reason: 'user' })
  ).rejects.toThrow('terminal_tab_pinned')
  expect(f.hasTab()).toBe(true)
})
it('reports host persistence failure after renderer ack without claiming durable success', async () => {
  const f = fixture()
  const pending = f.runtime.closeMobileSessionTab(`id:${f.worktree}`, TAB, { reason: 'user' })
  await expect.poll(() => f.closeTerminalTab.mock.calls.length, { timeout: 2000 }).toBe(1)
  await f.entered.promise
  const fail = vi.spyOn(f.main, 'flushOrThrow').mockImplementationOnce(() => {
    throw new Error('disk_full')
  })
  f.gate.resolve()
  await expect(pending).rejects.toThrow('disk_full')
  fail.mockRestore()
  const restarted = new Store({ dataFile: f.file })
  expect(restarted.getWorkspaceSession().tabsByWorktree[f.worktree].some((t) => t.id === TAB)).toBe(
    true
  )
  restarted.flush()
})
it('retains force permission across an acknowledged close with a newly pinned row', async () => {
  const f = fixture()
  const pending = f.runtime.closeMobileSessionTab(`id:${f.worktree}`, TAB, {
    reason: 'user',
    force: true
  })
  await expect.poll(() => f.closeTerminalTab.mock.calls.length, { timeout: 2000 }).toBe(1)
  await f.entered.promise
  f.change((s) => ({
    ...s,
    tabsByWorktree: {
      ...s.tabsByWorktree,
      [f.worktree]: s.tabsByWorktree[f.worktree].map((t) => ({ ...t, isPinned: true }))
    }
  }))
  f.gate.resolve()
  await expect(pending).resolves.toEqual({ closed: true })
  expect(f.hasTab()).toBe(false)
})

it('protects a replacement execution-host partition while acknowledgement is pending', async () => {
  const f = fixture()
  const pending = f.runtime.closeMobileSessionTab(`id:${f.worktree}`, TAB, { reason: 'user' })
  await expect.poll(() => f.closeTerminalTab.mock.calls.length, { timeout: 2000 }).toBe(1)
  await f.entered.promise
  f.main.setWorkspaceSession(f.main.getWorkspaceSession(), 'ssh:replacement')
  f.main.updateRepo('repo1', { executionHostId: 'ssh:replacement' })
  f.gate.resolve()
  await expect(pending).resolves.toMatchObject({ refused: true, refusalReason: 'stale-terminal' })
  expect(
    f.main
      .getWorkspaceSession('ssh:replacement')
      .tabsByWorktree[f.worktree].some((t) => t.id === TAB)
  ).toBe(true)
  expect(f.hasTab()).toBe(true)
})
it('also commits when the renderer graph removal arrives before acknowledgement', async () => {
  const f = fixture()
  const pending = f.runtime.closeMobileSessionTab(`id:${f.worktree}`, TAB, { reason: 'user' })
  await expect.poll(() => f.closeTerminalTab.mock.calls.length, { timeout: 2000 }).toBe(1)
  await f.entered.promise
  f.publish(false, 2)
  f.gate.resolve()
  await expect(pending).resolves.toEqual({ closed: true })
  expect(f.hasTab()).toBe(false)
})
it('documents live snapshot pending until graph removal, then rejects the older queued graph', async () => {
  const f = fixture()
  const pending = f.runtime.closeMobileSessionTab(`id:${f.worktree}`, TAB, { reason: 'user' })
  await expect.poll(() => f.closeTerminalTab.mock.calls.length, { timeout: 2000 }).toBe(1)
  await f.entered.promise
  f.gate.resolve()
  await expect(pending).resolves.toEqual({ closed: true })
  expect(f.runtime.surfaceParents(f.worktree)).toEqual([TAB])
  expect(f.hasTab()).toBe(false)
  f.publish(false, 3)
  expect(f.runtime.surfaceParents(f.worktree), 'after current removal graph').toEqual([])
  f.runtime.syncWindowGraph(1, {
    ...f.initialGraph,
    mobileSessionTabs: f.initialGraph.mobileSessionTabs.map((s) => ({ ...s, snapshotVersion: 2 }))
  })
  expect(f.runtime.surfaceParents(f.worktree)).toEqual([])
  expect(f.hasTab()).toBe(false)
})
