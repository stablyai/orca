import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import { TEST_LEAF_1, TEST_LEAF_2 } from '../../persistence-session-fixtures'
import type { Store } from '../loading-store/store'
import { closeLeafOrTab } from './terminal-topology-commit'
import {
  emptyTerminalSessionProfile,
  FIXTURE_GIT_WORKTREE_ID,
  openTopologyStore
} from './terminal-topology-profile-fixture'
import { WindowSession, withoutLeaf } from './terminal-topology-window-session-fixture'
import { checkWorkspaceLayoutRules } from '../../../shared/workspace-layout/workspace-layout-rules'

vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../ssh/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))

// A terminal's spawn can commit after the user already closed or moved its pane. The runtime's
// layout must not grow the pane back where it was.

const WT = FIXTURE_GIT_WORKTREE_ID
const directories: string[] = []

async function openWithSplit(): Promise<{ store: Store; window: WindowSession }> {
  const directory = mkdtempSync(join(tmpdir(), 'orca-late-bind-'))
  directories.push(directory)
  const store = await openTopologyStore(directory, emptyTerminalSessionProfile())
  const window = new WindowSession(structuredClone(store.getWorkspaceSession()))
  window.addTab(WT, 'tab-a', TEST_LEAF_1)
  window.setLayout(
    'tab-a',
    {
      type: 'split',
      direction: 'vertical',
      first: { type: 'leaf', leafId: TEST_LEAF_1 },
      second: { type: 'leaf', leafId: TEST_LEAF_2 }
    },
    {}
  )
  store.setWorkspaceSession(window.snapshot())
  for (const [leafId, ptyId] of [
    [TEST_LEAF_1, 'pty-1'],
    [TEST_LEAF_2, 'pty-2']
  ] as const) {
    await expect(
      store.persistPtyBinding({ worktreeId: WT, tabId: 'tab-a', leafId, ptyId })
    ).resolves.toBe(true)
    window.bind('tab-a', leafId, ptyId)
  }
  store.setWorkspaceSession(window.snapshot())
  return { store, window }
}

function violations(store: Store): string[] {
  return checkWorkspaceLayoutRules([
    { hostId: LOCAL_EXECUTION_HOST_ID, session: store.getWorkspaceSession() }
  ]).map((violation) => `${violation.rule}: ${violation.detail}`)
}

describe('a terminal spawn that lands after its pane changed', () => {
  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  // #22955: a closed tab's late spawn re-created the tab.
  it('does not bring back a tab the user closed', async () => {
    const { store, window } = await openWithSplit()
    window.removeTab('tab-a')
    await store.runDurableMutation(
      closeLeafOrTab({
        worktreeId: WT,
        target: { kind: 'tab', tabId: 'tab-a' },
        options: { allowMissing: true, force: true, closedByLayoutOwner: true, reason: 'user' },
        requestedSession: store.getWorkspaceSession(),
        ownerMatches: () => true,
        hostId: () => LOCAL_EXECUTION_HOST_ID,
        getSession: (hostId) => store.getWorkspaceSession(hostId),
        setSession: (session, hostId) => store.setWorkspaceSession(session, hostId),
        onClosed: () => {}
      })
    )
    store.setWorkspaceSession(window.snapshot())
    await store.persistPtyBinding({
      worktreeId: WT,
      tabId: 'tab-a',
      leafId: TEST_LEAF_1,
      ptyId: 'pty-late'
    })
    expect(violations(store)).toEqual([])
    expect(store.getWorkspaceSession().tabsByWorktree[WT] ?? []).toEqual([])
    await store.freezeWritesAsync()
  })

  // Known on main: the runtime grafts the pane back into its source tab (one pane in two tabs);
  // only the window's no-drag-before-spawn guard keeps it off screen. Drop `fails` once fixed.
  it.fails('keeps a dragged-out pane in its new tab when its spawn lands late', async () => {
    const { store, window } = await openWithSplit()
    await expect(
      store.moveTerminalLeafToNewTab({
        worktreeId: WT,
        sourceTabId: 'tab-a',
        targetTabId: 'tab-b',
        leafId: TEST_LEAF_2,
        ptyId: 'pty-2'
      })
    ).resolves.toEqual({ status: 'moved', ptyId: 'pty-2' })
    const source = window.session.terminalLayoutsByTabId['tab-a']!
    window.setLayout('tab-a', withoutLeaf(source.root!, TEST_LEAF_2)!, { [TEST_LEAF_1]: 'pty-1' })
    window.addTab(WT, 'tab-b', TEST_LEAF_2)
    window.bind('tab-b', TEST_LEAF_2, 'pty-2')
    store.setWorkspaceSession(window.snapshot())
    expect(violations(store)).toEqual([])

    // The pane's spawn, started before the drag, commits against the tab it was split in.
    await store.persistPtyBinding({
      worktreeId: WT,
      tabId: 'tab-a',
      leafId: TEST_LEAF_2,
      ptyId: 'pty-2b'
    })
    try {
      expect(violations(store)).toEqual([])
    } finally {
      await store.freezeWritesAsync()
    }
  })
})
