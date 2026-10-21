import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import type { Store } from '../loading-store/store'
import { leafIds, WindowSession } from './terminal-topology-window-session-fixture'
import {
  emptyTerminalSessionProfile,
  FIXTURE_GIT_WORKTREE_ID,
  openTopologyStore
} from './terminal-topology-profile-fixture'

vi.mock('../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))
vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../ssh/config/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))

const WORKTREE = FIXTURE_GIT_WORKTREE_ID
const TAB = 'tab-1'
const LEAF = '11111111-1111-4111-8111-111111111111'
const NEW_LEAF = '22222222-2222-4222-8222-222222222222'
const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

/** One tab with leftovers a full load-and-save rewrite would drop or renumber. */
async function storeWithLeftovers(): Promise<Store> {
  const directory = mkdtempSync(join(tmpdir(), 'orca-pane-admission-'))
  directories.push(directory)
  const store = await openTopologyStore(directory, emptyTerminalSessionProfile())
  const window = new WindowSession(getDefaultWorkspaceSession())
  window.addTab(WORKTREE, TAB, LEAF)
  window.bind(TAB, LEAF, 'pty-1')
  window.session.terminalPtyIncarnationsByPaneKey = { [`${TAB}:${LEAF}`]: 'incarnation-1' }
  window.session.tabsByWorktree[WORKTREE]![0]!.sortOrder = 7
  store.setWorkspaceSession(window.snapshot())
  return store
}

const admission = {
  type: 'splitPane',
  workspace: WORKTREE,
  tabId: TAB,
  leafId: LEAF,
  direction: 'vertical',
  newLeafId: NEW_LEAF
} as const

const root = (store: Store) => store.getWorkspaceSession().terminalLayoutsByTabId[TAB]?.root

describe('a runtime pane in a layout-owner build', () => {
  it('is written and taken back touching no other record', async () => {
    const store = await storeWithLeftovers()
    const stored = store.getWorkspaceSession()

    await expect(store.admitTerminalPane(admission)).resolves.toBe('admitted')
    const admitted = store.getWorkspaceSession()
    expect(leafIds(root(store))).toEqual([LEAF, NEW_LEAF])
    expect(admitted.terminalPtyIncarnationsByPaneKey).toEqual(
      stored.terminalPtyIncarnationsByPaneKey
    )
    expect(admitted.tabsByWorktree).toEqual(stored.tabsByWorktree)

    await store.withdrawTerminalPane({
      type: 'closePane',
      workspace: WORKTREE,
      tabId: TAB,
      leafId: NEW_LEAF
    })
    const withdrawn = store.getWorkspaceSession()
    expect(leafIds(root(store))).toEqual([LEAF])
    expect(withdrawn.tabsByWorktree).toEqual(stored.tabsByWorktree)
    expect(withdrawn.terminalPtyIncarnationsByPaneKey).toEqual(
      stored.terminalPtyIncarnationsByPaneKey
    )
  })

  it('comes back when the window records it after it was taken back, and only once', async () => {
    const store = await storeWithLeftovers()
    const { newLeafId: _newLeafId, ...split } = admission
    const record = { ...split, newLeafId: NEW_LEAF }
    await store.admitTerminalPane(admission)

    // Main still holds it: the window's record changes nothing.
    await store.applyLayoutCommand(record)
    expect(leafIds(root(store))).toEqual([LEAF, NEW_LEAF])

    await store.withdrawTerminalPane({
      type: 'closePane',
      workspace: WORKTREE,
      tabId: TAB,
      leafId: NEW_LEAF
    })
    await store.applyLayoutCommand(record)
    expect(leafIds(root(store))).toEqual([LEAF, NEW_LEAF])
    await store.applyLayoutCommand(record)
    expect(leafIds(root(store))).toEqual([LEAF, NEW_LEAF])
  })
})
