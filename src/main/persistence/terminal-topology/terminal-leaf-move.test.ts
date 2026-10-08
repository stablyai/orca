import { afterEach, describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { toSshExecutionHostId } from '../../../shared/execution-host'
import { _resetTracerForTests, setActiveSink } from '../../observability/tracer'
import { makeRepo, makeTerminalTab } from '../../persistence-test-harness'
import { planTerminalLeafMove } from './terminal-leaf-move'
import {
  closeMoveTestStores,
  FROM,
  LEFT,
  MOVED,
  moveRequest,
  newDataFile,
  openStore,
  ownersOf,
  seedSplitSource,
  sleeping,
  SOURCE,
  TARGET,
  tabsHoldingLeaf,
  TO,
  WT
} from './terminal-leaf-move-fixture'

vi.mock('electron', () => ({
  app: {
    getPath: () => tmpdir(),
    getName: () => 'orca-test',
    getVersion: () => '0.0.0-test',
    isPackaged: false,
    on: () => {},
    whenReady: () => Promise.resolve()
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString()
  },
  ipcMain: { on: () => {}, handle: () => {} },
  BrowserWindow: { getAllWindows: () => [] }
}))

afterEach(closeMoveTestStores)

describe('moving a pane to a new tab', () => {
  it('moves the leaf and its binding in one write and re-keys pane-keyed records', async () => {
    const store = openStore(newDataFile())
    await seedSplitSource(store)
    store.setWorkspaceSession({
      ...store.getWorkspaceSession(),
      sleepingAgentSessionsByPaneKey: { [FROM]: sleeping(FROM, SOURCE) }
    })
    store.updateUI({
      acknowledgedAgentsByPaneKey: { [FROM]: 10 },
      activityClearedAtByPaneKey: { [FROM]: 11 },
      manuallyUnreadTurnsByPaneKey: { [FROM]: 12 }
    })

    await expect(
      store.moveTerminalLeafToNewTab({ ...moveRequest, ptyId: 'pty-agent' })
    ).resolves.toEqual({ status: 'moved', ptyId: 'pty-agent' })

    const session = store.getWorkspaceSession()
    expect(session.tabsByWorktree[WT]?.map((tab) => tab.id)).toEqual([SOURCE, TARGET])
    expect(session.terminalLayoutsByTabId[SOURCE]).toMatchObject({
      root: { type: 'leaf', leafId: LEFT },
      ptyIdsByLeafId: { [LEFT]: 'pty-left' }
    })
    expect(session.terminalLayoutsByTabId[TARGET]).toMatchObject({
      root: { type: 'leaf', leafId: MOVED },
      ptyIdsByLeafId: { [MOVED]: 'pty-agent' }
    })
    expect(session.terminalPtyIncarnationsByPaneKey).toEqual({
      [`${SOURCE}:${LEFT}`]: 'inc-left',
      [TO]: 'inc-1'
    })
    expect(session.sleepingAgentSessionsByPaneKey).toEqual({
      [TO]: expect.objectContaining({ paneKey: TO, tabId: TARGET })
    })
    expect(store.getUI()).toMatchObject({
      acknowledgedAgentsByPaneKey: { [TO]: 10 },
      activityClearedAtByPaneKey: { [TO]: 11 },
      manuallyUnreadTurnsByPaneKey: { [TO]: 12 }
    })
    expect(ownersOf(session, 'pty-agent')).toEqual([TO])
  })

  it('re-keys the SSH lease and moves within the partition that holds the tab', async () => {
    const store = openStore(newDataFile())
    const hostId = toSshExecutionHostId('ssh-1')
    await seedSplitSource(store, hostId)
    store.upsertSshRemotePtyLease({
      targetId: 'ssh-1',
      ptyId: 'pty-agent',
      worktreeId: WT,
      tabId: SOURCE,
      leafId: MOVED,
      state: 'attached'
    })

    await expect(
      store.moveTerminalLeafToNewTab({ ...moveRequest, ptyId: 'pty-agent' })
    ).resolves.toMatchObject({ status: 'moved' })

    expect(tabsHoldingLeaf(store.getWorkspaceSession(hostId), MOVED)).toEqual([TARGET])
    expect(store.getWorkspaceSession().tabsByWorktree[WT]).toBeUndefined()
    expect(store.getSshRemotePtyLeases('ssh-1')).toEqual([
      expect.objectContaining({ ptyId: 'pty-agent', tabId: TARGET, leafId: MOVED })
    ])
  })

  it('reports a leaf main never held instead of inventing one', async () => {
    const store = openStore(newDataFile())
    await expect(
      store.moveTerminalLeafToNewTab({ ...moveRequest, ptyId: 'pty-agent' })
    ).resolves.toEqual({ status: 'not_held' })
    expect(store.getWorkspaceSession().tabsByWorktree[WT]).toBeUndefined()
  })

  it('refuses a move that names another terminal or an existing tab', async () => {
    const store = openStore(newDataFile())
    await seedSplitSource(store)
    await expect(
      store.moveTerminalLeafToNewTab({ ...moveRequest, ptyId: 'pty-other' })
    ).resolves.toEqual({ status: 'refused', reason: 'pty_mismatch' })
    await expect(
      store.moveTerminalLeafToNewTab({ ...moveRequest, targetTabId: SOURCE, ptyId: 'pty-agent' })
    ).resolves.toEqual({ status: 'refused', reason: 'target_tab_exists' })
    expect(tabsHoldingLeaf(store.getWorkspaceSession(), MOVED)).toEqual([SOURCE])
  })

  it('moves a leaf that a stray layout of a removed tab still names', () => {
    const planned = planTerminalLeafMove(
      [
        {
          hostId: 'local',
          session: {
            activeRepoId: 'repo-1',
            activeWorktreeId: WT,
            activeTabId: SOURCE,
            tabsByWorktree: { [WT]: [makeTerminalTab({ id: SOURCE, worktreeId: WT })] },
            terminalLayoutsByTabId: {
              [SOURCE]: {
                root: {
                  type: 'split',
                  direction: 'vertical',
                  first: { type: 'leaf', leafId: LEFT },
                  second: { type: 'leaf', leafId: MOVED }
                },
                activeLeafId: LEFT,
                expandedLeafId: null
              },
              'tab-removed': {
                root: { type: 'leaf', leafId: MOVED },
                activeLeafId: MOVED,
                expandedLeafId: null
              }
            }
          }
        }
      ],
      { ...moveRequest, ptyId: 'pty-agent' }
    )
    expect(planned.result).toEqual({ status: 'moved', ptyId: 'pty-agent' })
  })

  it('records a persistence.terminal-topology span without pane keys or PTY ids', async () => {
    const records: { name: string; attributes: Record<string, unknown> }[] = []
    setActiveSink({
      push: (record) => {
        records.push(JSON.parse(JSON.stringify(record)))
      },
      flush: () => {},
      close: () => {}
    })
    try {
      const store = openStore(newDataFile())
      await seedSplitSource(store)
      records.length = 0
      const request = { ...moveRequest, ptyId: 'pty-agent' }
      await store.moveTerminalLeafToNewTab(request)
      await store.moveTerminalLeafToNewTab(request)
      await store.moveTerminalLeafToNewTab({ ...request, targetTabId: 'tab-other' })

      const spans = records.filter((record) => record.name === 'persistence.terminal-topology')
      expect(spans.map((span) => span.attributes)).toEqual([
        { kind: 'persistence', 'topology.kind': 'move_leaf', 'topology.outcome': 'committed' },
        {
          kind: 'persistence',
          'topology.kind': 'move_leaf',
          'topology.outcome': 'refused',
          'topology.refusal': 'target_tab_exists'
        },
        {
          kind: 'persistence',
          'topology.kind': 'move_leaf',
          'topology.outcome': 'refused',
          'topology.refusal': 'leaf_in_other_tab'
        }
      ])
      expect(JSON.stringify(spans)).not.toMatch(/pty-|tab-source|tab-target|2222/)
    } finally {
      _resetTracerForTests()
    }
  })
})

// After a restart the relay reattach writes the SSH pane into `local` as well as `ssh:`; a move
// that left either copy behind refused the moved pane and the next relay reattach.
describe('moving an SSH pane held by both partitions', () => {
  it('moves every copy, so the target reattach and the next relay reattach both bind', async () => {
    const store = openStore(newDataFile())
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const hostId = toSshExecutionHostId('ssh-1')
    await seedSplitSource(store, hostId)
    const relay = { worktreeId: WT, leafId: MOVED, ptyId: 'pty-agent', incarnationId: 'inc-1' }
    expect(
      await store.persistPtyBinding({ ...relay, tabId: SOURCE, origin: 'relay_reattach' })
    ).toBe(true)

    await expect(
      store.moveTerminalLeafToNewTab({ ...moveRequest, ptyId: 'pty-agent' })
    ).resolves.toMatchObject({ status: 'moved' })

    expect(tabsHoldingLeaf(store.getWorkspaceSession(), MOVED)).toEqual([TARGET])
    expect(tabsHoldingLeaf(store.getWorkspaceSession(hostId), MOVED)).toEqual([TARGET])
    expect(
      await store.persistPtyBinding({ ...relay, tabId: TARGET, origin: 'reattach' }, hostId)
    ).toBe(true)
    expect(
      await store.persistPtyBinding({
        ...relay,
        tabId: TARGET,
        origin: 'relay_reattach',
        mayReviveRetiredSurface: false
      })
    ).toBe(true)
  })

  // Relay reattach into local, move, target reattach in ssh:, next-start relay reattach.
  it('keeps one holder per partition across a restart, and the next relay reattach binds', async () => {
    const dataFile = newDataFile()
    const store = openStore(dataFile)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    store.addRepo(makeRepo({ id: 'repo-1', path: '/tmp/move-worktree' }))
    const hostId = toSshExecutionHostId('ssh-1')
    await seedSplitSource(store, hostId)
    const relay = { worktreeId: WT, leafId: MOVED, ptyId: 'pty-agent', incarnationId: 'inc-1' }
    await store.persistPtyBinding({ ...relay, tabId: SOURCE, origin: 'relay_reattach' })
    await store.moveTerminalLeafToNewTab({ ...moveRequest, ptyId: 'pty-agent' })
    expect(
      await store.persistPtyBinding({ ...relay, tabId: TARGET, origin: 'reattach' }, hostId)
    ).toBe(true)
    store.flush()

    const restarted = openStore(dataFile)
    expect(
      await restarted.persistPtyBinding({
        ...relay,
        tabId: TARGET,
        origin: 'relay_reattach',
        mayReviveRetiredSurface: false
      })
    ).toBe(true)
    for (const session of [
      restarted.getWorkspaceSession(),
      restarted.getWorkspaceSession(hostId)
    ]) {
      expect(tabsHoldingLeaf(session, MOVED)).toEqual([TARGET])
      expect(ownersOf(session, 'pty-agent')).toEqual([TO])
    }
  })

  it('follows the live PTY when an SSH respawn bound one partition before the other', async () => {
    const store = openStore(newDataFile())
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const hostId = toSshExecutionHostId('ssh-1')
    await seedSplitSource(store, hostId)
    const relay = { worktreeId: WT, tabId: SOURCE, leafId: MOVED, incarnationId: 'inc-1' }
    await store.persistPtyBinding({ ...relay, ptyId: 'pty-agent', origin: 'relay_reattach' })
    await store.persistPtyBinding(
      { ...relay, ptyId: 'pty-respawn', incarnationId: 'inc-2' },
      hostId
    )

    await expect(
      store.moveTerminalLeafToNewTab({ ...moveRequest, ptyId: 'pty-respawn' })
    ).resolves.toEqual({ status: 'moved', ptyId: 'pty-respawn' })

    for (const session of [store.getWorkspaceSession(), store.getWorkspaceSession(hostId)]) {
      expect(tabsHoldingLeaf(session, MOVED)).toEqual([TARGET])
      expect(session.terminalLayoutsByTabId[TARGET]?.ptyIdsByLeafId).toEqual({
        [MOVED]: 'pty-respawn'
      })
    }
    expect(store.getWorkspaceSession(hostId).terminalPtyIncarnationsByPaneKey?.[TO]).toBe('inc-2')
    expect(store.getWorkspaceSession().terminalPtyIncarnationsByPaneKey?.[TO]).toBeUndefined()
  })

  it('refuses a move while another tab already holds the leaf', async () => {
    const store = openStore(newDataFile())
    await seedSplitSource(store)
    const session = store.getWorkspaceSession()
    store.setWorkspaceSession({
      ...session,
      tabsByWorktree: {
        ...session.tabsByWorktree,
        [WT]: [
          ...(session.tabsByWorktree[WT] ?? []),
          { ...(session.tabsByWorktree[WT] ?? [])[0]!, id: 'tab-earlier-move' }
        ]
      },
      terminalLayoutsByTabId: {
        ...session.terminalLayoutsByTabId,
        'tab-earlier-move': {
          root: { type: 'leaf', leafId: MOVED },
          activeLeafId: MOVED,
          expandedLeafId: null
        }
      }
    })

    await expect(
      store.moveTerminalLeafToNewTab({ ...moveRequest, ptyId: 'pty-agent' })
    ).resolves.toEqual({ status: 'refused', reason: 'leaf_in_other_tab' })
  })
})

// STA-9259: detach, then the moved pane's reattach binding, then a renderer snapshot that still
// shows the pre-move layout, then a restart. Before the move transaction this left one leaf and
// one PTY in both tabs.
describe('STA-9259 move sequence', () => {
  it('keeps one owner through reattach, a stale renderer save and a restart', async () => {
    const dataFile = newDataFile()
    const store = openStore(dataFile)
    // Load sweeps sessions of unregistered repos, so the restart needs a real owner.
    store.addRepo(makeRepo({ id: 'repo-1', path: '/tmp/move-worktree' }))
    await seedSplitSource(store)
    const preMoveRendererSnapshot = structuredClone(store.getWorkspaceSession())

    await store.moveTerminalLeafToNewTab({ ...moveRequest, ptyId: 'pty-agent' })
    // The moved pane mounts in the target tab and reattaches with its stable-owner fence.
    const reattached = await store.persistPtyBinding({
      worktreeId: WT,
      tabId: TARGET,
      leafId: MOVED,
      ptyId: 'pty-agent',
      incarnationId: 'inc-1',
      expectedBinding: { ptyId: 'pty-agent', incarnationId: 'inc-1' },
      origin: 'reattach'
    })
    expect(reattached).toBe(true)
    // A debounced renderer save that predates the move must not resurrect the source copy.
    store.setWorkspaceSession(preMoveRendererSnapshot)
    expect(ownersOf(store.getWorkspaceSession(), 'pty-agent')).toEqual([TO])
    expect(tabsHoldingLeaf(store.getWorkspaceSession(), MOVED)).toEqual([TARGET])

    store.flush()
    const restarted = openStore(dataFile)
    expect(ownersOf(restarted.getWorkspaceSession(), 'pty-agent')).toEqual([TO])
    expect(tabsHoldingLeaf(restarted.getWorkspaceSession(), MOVED)).toEqual([TARGET])
  })
})
