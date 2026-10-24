import { afterEach, describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { dirname } from 'node:path'
import type { TerminalLeafIntoTabRequest } from '../../../shared/terminal-leaf-move'
import { _resetTracerForTests, setActiveSink } from '../../observability/tracer'
import { makeRepo } from '../../persistence-test-harness'
import {
  openProfileStateDatabaseReadOnly,
  profileStateDatabaseFile
} from '../profile-state/profile-state-database'
import {
  closeMoveTestStores,
  LEFT,
  MOVED,
  newDataFile,
  openStore,
  ownersOf,
  SOURCE,
  TARGET,
  tabsHoldingLeaf,
  TO,
  FROM,
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

const request: TerminalLeafIntoTabRequest = {
  worktreeId: WT,
  sourceTabId: SOURCE,
  targetTabId: TARGET,
  targetLeafId: LEFT,
  leafId: MOVED,
  ptyId: 'pty-agent',
  placement: { kind: 'beside', side: 'right' }
}

async function seed(dataFile: string) {
  const store = openStore(dataFile)
  store.addRepo(makeRepo({ id: 'repo-1', path: '/tmp/move-worktree' }))
  await store.persistPtyBinding({
    worktreeId: WT,
    tabId: SOURCE,
    leafId: MOVED,
    ptyId: 'pty-agent',
    incarnationId: 'inc-1'
  })
  await store.persistPtyBinding({
    worktreeId: WT,
    tabId: TARGET,
    leafId: LEFT,
    ptyId: 'pty-left',
    incarnationId: 'inc-left'
  })
  return store
}

function readDocument(dataFile: string, domain: string): string {
  const opened = openProfileStateDatabaseReadOnly(
    profileStateDatabaseFile(dirname(dataFile)),
    'persistence-test'
  )
  try {
    const row: unknown = opened.db
      .prepare('SELECT payload FROM profile_state_documents WHERE domain = ?')
      .get(domain)
    return row && typeof row === 'object' && 'payload' in row ? String(row.payload) : ''
  } finally {
    opened.db.close()
  }
}

describe('Store.moveTerminalLeafIntoTab', () => {
  it('joins the leaf into the existing tab and closes the source, surviving a restart', async () => {
    const dataFile = newDataFile()
    const store = await seed(dataFile)

    await expect(store.moveTerminalLeafIntoTab(request)).resolves.toEqual({
      status: 'moved',
      ptyId: 'pty-agent',
      sourceTabClosed: true
    })

    const live = store.getWorkspaceSession()
    expect(live.tabsByWorktree[WT]?.map((tab) => tab.id)).toEqual([TARGET])
    expect(ownersOf(live, 'pty-agent')).toEqual([TO])
    store.flush()
    const restarted = openStore(dataFile).getWorkspaceSession()
    expect(tabsHoldingLeaf(restarted, MOVED)).toEqual([TARGET])
    expect(ownersOf(restarted, 'pty-agent')).toEqual([TO])
    expect(ownersOf(restarted, 'pty-left')).toEqual([`${TARGET}:${LEFT}`])
    expect(restarted.closedTerminalTabTombstonesByTabId?.[SOURCE]).toBeDefined()
  })

  // The hook server persists its aliases on a debounce; nothing here calls it.
  it('writes the alias to disk together with the source close, before any hook-server save', async () => {
    const dataFile = newDataFile()
    const store = await seed(dataFile)

    await store.moveTerminalLeafIntoTab(request)

    // Read before any flush: the alias must already be on disk from the move's own write.
    expect(JSON.parse(readDocument(dataFile, 'legacyPaneKeyAliasEntries'))).toEqual([
      { ptyId: 'pty-agent', legacyPaneKey: FROM, stablePaneKey: TO, updatedAt: expect.any(Number) }
    ])
    const onDisk = JSON.parse(readDocument(dataFile, 'workspaceSession'))
    expect(Object.keys(onDisk.terminalLayoutsByTabId)).toEqual([TARGET])
  })

  it('keeps the move when a stale renderer save that still shows the source tab arrives', async () => {
    const store = await seed(newDataFile())
    const preMoveRendererSnapshot = structuredClone(store.getWorkspaceSession())

    await store.moveTerminalLeafIntoTab(request)
    store.setWorkspaceSession(preMoveRendererSnapshot)

    expect(ownersOf(store.getWorkspaceSession(), 'pty-agent')).toEqual([TO])
    expect(tabsHoldingLeaf(store.getWorkspaceSession(), MOVED)).toEqual([TARGET])
  })

  it('reports a leaf main never held and refuses a target it lacks, changing nothing', async () => {
    const store = await seed(newDataFile())
    const before = structuredClone(store.getWorkspaceSession())

    await expect(
      store.moveTerminalLeafIntoTab({ ...request, leafId: '66666666-6666-4666-8666-666666666666' })
    ).resolves.toEqual({ status: 'not_held' })
    await expect(
      store.moveTerminalLeafIntoTab({ ...request, targetTabId: 'tab-gone' })
    ).resolves.toEqual({
      status: 'refused',
      reason: 'target_tab_missing'
    })

    expect(store.getWorkspaceSession()).toEqual(before)
  })

  it('records a move_leaf_into_tab span without pane keys or PTY ids', async () => {
    const records: { name: string; attributes: Record<string, unknown> }[] = []
    setActiveSink({
      push: (record) => {
        records.push(JSON.parse(JSON.stringify(record)))
      },
      flush: () => {},
      close: () => {}
    })
    try {
      const store = await seed(newDataFile())
      records.length = 0
      await store.moveTerminalLeafIntoTab(request)

      const spans = records.filter((record) => record.name === 'persistence.terminal-topology')
      expect(spans.map((span) => span.attributes)).toEqual([
        {
          kind: 'persistence',
          'topology.kind': 'move_leaf_into_tab',
          'topology.outcome': 'committed'
        }
      ])
    } finally {
      _resetTracerForTests()
    }
  })
})
