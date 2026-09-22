import { expect, vi } from 'vitest'
import { OrcaRuntimeService } from '../../../src/main/runtime/orca-runtime'
import {
  buildMobileSessionTabSnapshots,
  registerRuntimeTerminalTab,
  setRuntimeGraphStoreStateGetter,
  setRuntimeGraphSyncEnabled
} from '../../../src/renderer/src/runtime/sync-runtime-graph'
import { makeState } from '../../../src/renderer/src/runtime/sync-runtime-graph-test-harness'
import { graphState } from '../../../src/renderer/src/runtime/sync-runtime-graph/graph-state'

if (process.env.ORCA_BACKGROUND_LAUNCH !== '1') {
  throw new Error('background required')
}

const TAB = '10000000-0000-4000-8000-000000000001'
const TEST_WORKTREE_PATH = '/tmp/worktree-a'
const TEST_WORKTREE_ID = `repo-1::${TEST_WORKTREE_PATH}`
const LEAF = '10000000-0000-4000-8000-000000000002'
const INC = '10000000-0000-4000-8000-000000000003'
const PTY = `${TEST_WORKTREE_ID}@@sleep-review`

export async function runPreservedHistoryScenario() {
  const runtime = new OrcaRuntimeService()
  const worktree = {
    id: TEST_WORKTREE_ID,
    path: TEST_WORKTREE_PATH,
    repoId: 'repo-1',
    name: 'worktree-a',
    branch: 'main',
    isMain: false
  }
  vi.spyOn(runtime, 'resolveWorktreeSelector').mockResolvedValue(worktree)
  vi.spyOn(runtime, 'getResolvedWorktreeMap').mockResolvedValue(
    new Map([[TEST_WORKTREE_ID, worktree]])
  )
  let stopped = false
  let finishStop!: () => void
  const stopGate = new Promise<void>((resolve) => {
    finishStop = resolve
  })
  const stop = vi.fn(async () => {
    runtime.onPtyExit(PTY, 0, INC, { providerExitObserved: true })
    stopped = true
    await stopGate
    return true
  })
  runtime.setPtyController({
    write: () => true,
    kill: () => true,
    stopAndWait: stop,
    getForegroundProcess: async () => null,
    hasPty: () => !stopped,
    listProcesses: async () =>
      stopped ? [] : [{ id: PTY, cwd: TEST_WORKTREE_PATH, title: 'terminal', incarnationId: INC }]
  })
  let currentPty: string | null = PTY
  const state = makeState({
    tabsByWorktree: {
      [TEST_WORKTREE_ID]: [
        {
          id: TAB,
          worktreeId: TEST_WORKTREE_ID,
          title: 'Terminal',
          ptyId: PTY,
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    },
    terminalLayoutsByTabId: {
      [TAB]: {
        root: { type: 'leaf', leafId: LEAF },
        activeLeafId: LEAF,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF]: PTY }
      }
    }
  })
  const manager = {
    getPanes: () => [{ id: 1, leafId: LEAF }],
    getActivePane: () => ({ id: 1, leafId: LEAF }),
    getLeafId: () => LEAF,
    getNumericIdForLeaf: () => 1
  }
  setRuntimeGraphSyncEnabled(false)
  setRuntimeGraphStoreStateGetter(() => state)
  const unregister = registerRuntimeTerminalTab({
    tabId: TAB,
    worktreeId: TEST_WORKTREE_ID,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the snapshot builder reads only these four supplied pane lookup methods.
    getManager: () => manager as never,
    getContainer: () => null,
    getPtyIdForPane: () => currentPty,
    getTabWideAgentHintLeafId: () => null
  })
  const publish = () => {
    const snapshots = buildMobileSessionTabSnapshots(state)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: TAB,
          worktreeId: TEST_WORKTREE_ID,
          title: 'Terminal',
          activeLeafId: LEAF,
          layout: null
        }
      ],
      leaves: [
        {
          tabId: TAB,
          worktreeId: TEST_WORKTREE_ID,
          leafId: LEAF,
          paneRuntimeId: 1,
          ptyId: currentPty
        }
      ],
      mobileSessionTabs: snapshots
    })
    return snapshots[0]
  }
  const capture = () =>
    runtime['mobileSessionTabsByWorktree'].get(TEST_WORKTREE_ID)?.tabs.map((tab) => ({
      type: tab.type,
      id: tab.id,
      ptyId: tab.type === 'terminal' ? tab.ptyId : null
    }))
  try {
    runtime.registerPty(PTY, TEST_WORKTREE_ID, null, {
      tabId: TAB,
      leafId: LEAF,
      incarnationId: INC
    })
    publish()
    const initial = capture()
    expect(initial).toHaveLength(1)
    const pending = runtime.stopExactTerminalsForWorktree(`id:${TEST_WORKTREE_ID}`, [PTY], {
      keepHistory: true,
      targetOnly: true
    })
    await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce())
    const afterExit = capture()
    expect(afterExit).toHaveLength(1)
    state.runtimePaneTitlesByTabId = { [TAB]: { 1: 'Sleeping terminal' } }
    const incoming = publish()
    const afterQueued = capture()
    const queuedLeaf = runtime['leaves'].get(runtime['getLeafKey'](TAB, LEAF))
    const leafState = queuedLeaf
      ? { connected: queuedLeaf.connected, writable: queuedLeaf.writable, ptyId: queuedLeaf.ptyId }
      : null
    const model = runtime['headlessTerminals'].has(PTY)
    finishStop()
    const result = await pending
    currentPty = null
    state.tabsByWorktree[TEST_WORKTREE_ID] = [
      { ...state.tabsByWorktree[TEST_WORKTREE_ID][0], ptyId: null }
    ]
    state.terminalLayoutsByTabId[TAB] = { ...state.terminalLayoutsByTabId[TAB], ptyIdsByLeafId: {} }
    publish()
    return {
      initial,
      afterExit,
      incoming,
      afterQueued,
      leafState,
      model,
      afterBindingClear: capture(),
      result
    }
  } finally {
    finishStop()
    graphState.syncEnabled = false
    unregister()
    runtime.onPtyExit(PTY, 0, INC)
    setRuntimeGraphStoreStateGetter(null)
    vi.restoreAllMocks()
  }
}
