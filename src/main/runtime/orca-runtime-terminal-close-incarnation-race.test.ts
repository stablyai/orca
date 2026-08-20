import { describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { FolderWorkspace } from '../../shared/folder-workspace-types'
import { makePaneKey } from '../../shared/stable-pane-id'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { folderWorkspaceKey } from '../../shared/workspace-scope'
import { OrcaRuntimeService } from './orca-runtime'

const REPO_ID = 'repo-close-incarnation-race'
const WORKTREE_PATH = '/tmp/terminal-close-incarnation-race'
const GIT_WORKSPACE_ID = `${REPO_ID}::${WORKTREE_PATH}`
const FOLDER_ID = 'folder-close-incarnation-race'
const FOLDER_WORKSPACE_ID = folderWorkspaceKey(FOLDER_ID)
const TAB_ID = 'tab-close-incarnation-race'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const PTY_A = 'pty-close-incarnation-a'
const PTY_B = 'pty-close-incarnation-b'
const INCARNATION_A = '22222222-2222-4222-8222-222222222222'
const INCARNATION_B = '33333333-3333-4333-8333-333333333333'

type CloseEntry = 'terminal.close' | 'terminal.closeTab'
type Surface = 'runtime-publication' | 'runtime-headless' | 'renderer-graph'
type Replacement = 'new-pty' | 'same-pty-new-incarnation'
type ExpectedTerminal = {
  terminalHandle: string
  ptyId: string
  leafId: string
  incarnationId?: string
}

type MatrixCase = {
  name: string
  entry: CloseEntry
  surface: Surface
  workspace: 'git' | 'folder'
  replacement: Replacement
}

const cases: MatrixCase[] = [
  {
    name: 'terminal.close runtime publication',
    entry: 'terminal.close',
    surface: 'runtime-publication',
    workspace: 'git',
    replacement: 'same-pty-new-incarnation'
  },
  {
    name: 'terminal.close renderer graph',
    entry: 'terminal.close',
    surface: 'renderer-graph',
    workspace: 'git',
    replacement: 'new-pty'
  },
  {
    name: 'terminal.close folder workspace',
    entry: 'terminal.close',
    surface: 'runtime-publication',
    workspace: 'folder',
    replacement: 'new-pty'
  },
  {
    name: 'terminal.closeTab runtime publication',
    entry: 'terminal.closeTab',
    surface: 'runtime-publication',
    workspace: 'git',
    replacement: 'same-pty-new-incarnation'
  },
  {
    name: 'terminal.closeTab renderer graph',
    entry: 'terminal.closeTab',
    surface: 'renderer-graph',
    workspace: 'git',
    replacement: 'new-pty'
  },
  {
    name: 'terminal.closeTab folder workspace',
    entry: 'terminal.closeTab',
    surface: 'runtime-publication',
    workspace: 'folder',
    replacement: 'new-pty'
  }
]

function makeDeferred() {
  let resolve!: () => void
  const promise = new Promise<void>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

function makeSession(workspaceId: string, ptyId: string, incarnationId: string) {
  return {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: {
      [workspaceId]: [
        {
          id: TAB_ID,
          ptyId,
          worktreeId: workspaceId,
          title: 'Incarnation fixture shell',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    },
    terminalLayoutsByTabId: {
      [TAB_ID]: {
        root: { type: 'leaf' as const, leafId: LEAF_ID },
        activeLeafId: LEAF_ID,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF_ID]: ptyId }
      }
    },
    terminalPtyIncarnationsByPaneKey: {
      [makePaneKey(TAB_ID, LEAF_ID)]: incarnationId
    }
  }
}

function makeFolderWorkspace(): FolderWorkspace {
  return {
    id: FOLDER_ID,
    projectGroupId: 'folder-group-close-incarnation-race',
    name: 'Close incarnation folder',
    folderPath: WORKTREE_PATH,
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
}

function createHarness(
  testCase: MatrixCase,
  options: { pauseProviderStop?: boolean; pauseIdOnlyKill?: boolean } = {}
) {
  const workspaceId = testCase.workspace === 'folder' ? FOLDER_WORKSPACE_ID : GIT_WORKSPACE_ID
  let session: WorkspaceSessionState = makeSession(workspaceId, PTY_A, INCARNATION_A)
  const liveProcesses = new Map([[PTY_A, INCARNATION_A]])
  const retiredPtys: string[] = []
  const rendererStoppedPtys: string[] = []
  const commitBarrier = makeDeferred()
  const providerStopEntered = makeDeferred()
  const providerStopBarrier = makeDeferred()
  const idOnlyKillBarrier = makeDeferred()
  const repo = {
    id: REPO_ID,
    path: WORKTREE_PATH,
    displayName: 'close-incarnation-race',
    badgeColor: '#000000',
    addedAt: 1
  }
  const folderWorkspace = makeFolderWorkspace()
  const store = {
    getRepos: () => [repo],
    getRepo: (id: string) => (id === REPO_ID ? repo : undefined),
    getAllWorktreeMeta: () => ({}),
    getWorktreeMeta: () => undefined,
    getSettings: () => ({ workspaceDir: '/tmp/workspaces' }),
    getProjects: () => [],
    getProjectGroups: () => [],
    getFolderWorkspaces: () => [folderWorkspace],
    getWorkspaceSession: () => session,
    setWorkspaceSession: (next: WorkspaceSessionState) => {
      session = next
    },
    flushOrThrow: () => {}
  }
  const closeTerminal = vi.fn()
  const closeTerminalTab = vi.fn(
    async (
      _tabId: string,
      options: {
        localPtyTeardownOwnedExternally?: boolean
        expectedTerminal?: ExpectedTerminal
      } = {}
    ) => {
      await commitBarrier.promise
      const currentPtyId = session.terminalLayoutsByTabId[TAB_ID]?.ptyIdsByLeafId?.[LEAF_ID]
      const currentIncarnation =
        session.terminalPtyIncarnationsByPaneKey?.[makePaneKey(TAB_ID, LEAF_ID)]
      const expected = options.expectedTerminal
      if (
        expected &&
        (expected.ptyId !== currentPtyId ||
          expected.leafId !== LEAF_ID ||
          expected.incarnationId !== currentIncarnation)
      ) {
        throw new Error('terminal_handle_stale')
      }
      if (currentPtyId) {
        retiredPtys.push(currentPtyId)
        if (!options.localPtyTeardownOwnedExternally) {
          rendererStoppedPtys.push(currentPtyId)
          liveProcesses.delete(currentPtyId)
        }
      }
      session = {
        ...session,
        tabsByWorktree: { ...session.tabsByWorktree, [workspaceId]: [] },
        terminalLayoutsByTabId: {},
        terminalPtyIncarnationsByPaneKey: {}
      }
    }
  )
  const stopAndWait = vi.fn(
    async (ptyId: string, stopOptions?: { expectedIncarnationId?: string }) => {
      providerStopEntered.resolve()
      if (options.pauseProviderStop) {
        await providerStopBarrier.promise
      }
      if (
        stopOptions?.expectedIncarnationId !== undefined &&
        liveProcesses.get(ptyId) !== stopOptions.expectedIncarnationId
      ) {
        return false
      }
      return liveProcesses.delete(ptyId)
    }
  )
  const kill = vi.fn((ptyId: string) => {
    if (options.pauseIdOnlyKill) {
      void idOnlyKillBarrier.promise.then(() => liveProcesses.delete(ptyId))
      return true
    }
    return liveProcesses.delete(ptyId)
  })
  const listProcesses = vi.fn(async () =>
    [...liveProcesses].map(([id, incarnationId]) => ({
      id,
      incarnationId,
      cwd: WORKTREE_PATH,
      title: `marker:${incarnationId}`
    }))
  )
  const runtime = new OrcaRuntimeService(store as never)
  runtime.setNotifier({ closeTerminal, closeTerminalTab } as never)
  runtime.setPtyController({
    write: () => true,
    kill,
    stopAndWait,
    listProcesses,
    getForegroundProcess: async () => null
  })
  runtime.attachWindow(1)

  const syncGraph = (ptyId: string, snapshotVersion: number) =>
    runtime.syncWindowGraph(1, {
      tabs:
        testCase.surface === 'runtime-headless'
          ? []
          : [
              {
                tabId: TAB_ID,
                worktreeId: workspaceId,
                title: 'Incarnation fixture shell',
                activeLeafId: LEAF_ID,
                layout: { type: 'leaf', leafId: LEAF_ID }
              }
            ],
      leaves:
        testCase.surface === 'runtime-headless'
          ? []
          : [
              {
                tabId: TAB_ID,
                worktreeId: workspaceId,
                leafId: LEAF_ID,
                paneRuntimeId: 7,
                ptyId
              }
            ],
      ...(testCase.surface !== 'renderer-graph'
        ? {
            mobileSessionTabs: [
              {
                worktree: workspaceId,
                publicationEpoch: 'renderer:close-incarnation-race',
                snapshotVersion,
                activeGroupId: null,
                activeTabId: `${TAB_ID}::${LEAF_ID}`,
                activeTabType: 'terminal' as const,
                tabs: [
                  {
                    type: 'terminal' as const,
                    id: `${TAB_ID}::${LEAF_ID}`,
                    parentTabId: TAB_ID,
                    leafId: LEAF_ID,
                    ptyId,
                    title: 'Incarnation fixture shell',
                    isActive: true
                  }
                ]
              }
            ]
          }
        : {})
    })

  if (testCase.surface !== 'renderer-graph') {
    runtime.registerPty(PTY_A, workspaceId, null, {
      tabId: TAB_ID,
      leafId: LEAF_ID,
      incarnationId: INCARNATION_A
    })
  }
  syncGraph(PTY_A, 1)

  const replaceWithB = async (replacementKind = testCase.replacement) => {
    const ptyId = replacementKind === 'same-pty-new-incarnation' ? PTY_A : PTY_B
    liveProcesses.clear()
    liveProcesses.set(ptyId, INCARNATION_B)
    session = makeSession(workspaceId, ptyId, INCARNATION_B)
    runtime.registerPty(ptyId, workspaceId, null, {
      tabId: TAB_ID,
      leafId: LEAF_ID,
      incarnationId: INCARNATION_B
    })
    syncGraph(ptyId, 2)
    const replacement = (await runtime.listTerminals(`id:${workspaceId}`)).terminals.find(
      (terminal) => terminal.ptyId === ptyId && terminal.incarnationId === INCARNATION_B
    )
    expect(replacement).toBeDefined()
    return replacement!
  }

  return {
    runtime,
    workspaceId,
    closeTerminalTab,
    commitBarrier,
    providerStopEntered,
    providerStopBarrier,
    idOnlyKillBarrier,
    replaceWithB,
    liveProcesses,
    kill,
    retiredPtys,
    rendererStoppedPtys,
    getSession: () => session
  }
}

async function invokeClose(runtime: OrcaRuntimeService, entry: CloseEntry, handle: string) {
  return entry === 'terminal.close'
    ? runtime.closeTerminal(handle)
    : runtime.closeTerminalTab(handle)
}

describe('handle-authorized final-pane close is incarnation safe', () => {
  it.each(cases)('$name refuses replacement B at the renderer commit barrier', async (testCase) => {
    const harness = createHarness(testCase)
    const [terminalA] = (await harness.runtime.listTerminals(`id:${harness.workspaceId}`)).terminals
    expect(terminalA).toMatchObject({ ptyId: PTY_A, incarnationId: INCARNATION_A })

    const closing = invokeClose(harness.runtime, testCase.entry, terminalA.handle)
    await vi.waitFor(() => expect(harness.closeTerminalTab).toHaveBeenCalledTimes(1))
    const terminalB = await harness.replaceWithB()
    harness.commitBarrier.resolve()

    await expect(closing).rejects.toThrow('terminal_handle_stale')
    expect(harness.getSession().tabsByWorktree[harness.workspaceId]).toHaveLength(1)
    expect(harness.liveProcesses.get(terminalB.ptyId!)).toBe(INCARNATION_B)
    expect(harness.retiredPtys).not.toContain(terminalB.ptyId)
    expect(harness.rendererStoppedPtys).not.toContain(terminalB.ptyId)
    expect(await harness.runtime.readTerminal(terminalB.handle)).toMatchObject({
      handle: terminalB.handle,
      status: 'running'
    })
  })

  it.each(cases)('$name still commits for unchanged A', async (testCase) => {
    const harness = createHarness(testCase)
    const [terminalA] = (await harness.runtime.listTerminals(`id:${harness.workspaceId}`)).terminals

    const closing = invokeClose(harness.runtime, testCase.entry, terminalA.handle)
    await vi.waitFor(() => expect(harness.closeTerminalTab).toHaveBeenCalledTimes(1))
    harness.commitBarrier.resolve()

    await expect(closing).resolves.toMatchObject({ handle: terminalA.handle, tabId: TAB_ID })
    expect(harness.getSession().tabsByWorktree[harness.workspaceId]).toEqual([])
    expect(harness.liveProcesses.has(PTY_A)).toBe(false)
    expect(harness.retiredPtys).toEqual([PTY_A])
  })

  it.each(cases)(
    '$name preserves B after renderer commit while provider stop waits',
    async (testCase) => {
      const harness = createHarness(testCase, { pauseProviderStop: true })
      const [terminalA] = (await harness.runtime.listTerminals(`id:${harness.workspaceId}`))
        .terminals

      const closing = invokeClose(harness.runtime, testCase.entry, terminalA.handle)
      await vi.waitFor(() => expect(harness.closeTerminalTab).toHaveBeenCalledTimes(1))
      harness.commitBarrier.resolve()
      await harness.providerStopEntered.promise

      const terminalB = await harness.replaceWithB('same-pty-new-incarnation')
      harness.providerStopBarrier.resolve()

      await closing.catch(() => undefined)
      expect(harness.getSession().tabsByWorktree[harness.workspaceId]).toHaveLength(1)
      expect(harness.liveProcesses.get(terminalB.ptyId!)).toBe(INCARNATION_B)
      expect(await harness.runtime.readTerminal(terminalB.handle)).toMatchObject({
        handle: terminalB.handle,
        status: 'running'
      })
    }
  )

  it('terminal.closeTab preserves a republished headless replacement while exact stop waits', async () => {
    const harness = createHarness(
      {
        name: 'terminal.closeTab runtime headless',
        entry: 'terminal.closeTab',
        surface: 'runtime-headless',
        workspace: 'git',
        replacement: 'same-pty-new-incarnation'
      },
      { pauseProviderStop: true, pauseIdOnlyKill: true }
    )
    const [terminalA] = (await harness.runtime.listTerminals(`id:${harness.workspaceId}`)).terminals

    const closing = harness.runtime.closeTerminalTab(terminalA.handle)
    await harness.providerStopEntered.promise
    const terminalB = await harness.replaceWithB()
    harness.idOnlyKillBarrier.resolve()
    harness.providerStopBarrier.resolve()

    await expect(closing).resolves.toMatchObject({
      handle: terminalA.handle,
      tabId: TAB_ID,
      ptyKilled: false
    })
    expect(harness.kill).not.toHaveBeenCalled()
    expect(harness.liveProcesses.get(terminalB.ptyId!)).toBe(INCARNATION_B)
    expect(harness.getSession().tabsByWorktree[harness.workspaceId]).toHaveLength(1)
    expect(await harness.runtime.readTerminal(terminalB.handle)).toMatchObject({
      handle: terminalB.handle,
      status: 'running'
    })
  })
})
