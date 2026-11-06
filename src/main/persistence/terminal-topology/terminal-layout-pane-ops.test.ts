import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import { applyCommandToSession } from './terminal-pane-admission'
import { leafIds, WindowSession } from './terminal-topology-window-session-fixture'
import {
  emptyTerminalSessionProfile,
  FIXTURE_GIT_WORKTREE_ID,
  openTopologyStore
} from './terminal-topology-profile-fixture'

vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../ssh/config/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))

const WORKTREE = FIXTURE_GIT_WORKTREE_ID
const TAB = 'tab-1'
const LEAF_A = '11111111-1111-4111-8111-111111111111'
const LEAF_B = '22222222-2222-4222-8222-222222222222'
const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('layout.apply closePane against the legacy pane close', () => {
  // Renderer already removed the pane; main must close it even if its terminal restarted meanwhile.
  it('closes a pane whose terminal restarted after the window asked', () => {
    const window = new WindowSession(getDefaultWorkspaceSession())
    window.addTab(WORKTREE, TAB, LEAF_A)
    window.setLayout(
      TAB,
      {
        type: 'split',
        direction: 'vertical',
        first: { type: 'leaf', leafId: LEAF_A },
        second: { type: 'leaf', leafId: LEAF_B }
      },
      { [LEAF_A]: 'pty-a', [LEAF_B]: 'pty-b-restarted' }
    )
    window.session.terminalPtyIncarnationsByPaneKey = { [`${TAB}:${LEAF_B}`]: 'incarnation-2' }

    const closed = applyCommandToSession('local', window.snapshot(), {
      type: 'closePane',
      workspace: WORKTREE,
      tabId: TAB,
      leafId: LEAF_B,
      userPaneClose: true
    })

    expect(closed.value.ok).toBe(true)
    expect(leafIds(closed.session?.terminalLayoutsByTabId[TAB]?.root)).toEqual([LEAF_A])
    expect(closed.session?.terminalPtyIncarnationsByPaneKey?.[`${TAB}:${LEAF_B}`]).toBeUndefined()
  })
})

describe('Store.applyLayoutCommand pane operations', () => {
  async function storeWithSplitTab(hostIds: string[]) {
    const directory = mkdtempSync(join(tmpdir(), 'orca-layout-pane-ops-'))
    directories.push(directory)
    const store = await openTopologyStore(directory, emptyTerminalSessionProfile())
    const window = new WindowSession(getDefaultWorkspaceSession())
    window.addTab(WORKTREE, TAB, LEAF_A)
    window.setLayout(
      TAB,
      {
        type: 'split',
        direction: 'vertical',
        ratio: 0.3,
        first: { type: 'leaf', leafId: LEAF_A },
        second: { type: 'leaf', leafId: LEAF_B }
      },
      { [LEAF_A]: 'pty-a', [LEAF_B]: 'pty-b' }
    )
    for (const hostId of hostIds) {
      store.setWorkspaceSession(window.snapshot(), hostId)
    }
    return store
  }

  it('closes the pane in every partition holding the tab', async () => {
    const store = await storeWithSplitTab(['local', 'ssh:target-1'])

    const reply = await store.applyLayoutCommand(
      { type: 'closePane', workspace: WORKTREE, tabId: TAB, leafId: LEAF_B, userPaneClose: true },
      ['local', 'ssh:target-1']
    )

    expect(reply.ok).toBe(true)
    for (const hostId of ['local', 'ssh:target-1']) {
      expect(leafIds(store.getWorkspaceSession(hostId).terminalLayoutsByTabId[TAB]?.root)).toEqual([
        LEAF_A
      ])
    }
  })

  it('saves a divider’s new ratios, and refuses a tree whose panes differ', async () => {
    const store = await storeWithSplitTab(['local'])
    const split = {
      type: 'split',
      direction: 'vertical',
      first: { type: 'leaf', leafId: LEAF_A },
      second: { type: 'leaf', leafId: LEAF_B }
    } as const
    const ratios = { type: 'setPaneRatios', workspace: WORKTREE, tabId: TAB } as const

    await store.applyLayoutCommand({ ...ratios, root: { ...split, ratio: 0.7 } })
    expect(store.getWorkspaceSession().terminalLayoutsByTabId[TAB]?.root).toEqual({
      ...split,
      ratio: 0.7
    })

    const reply = await store.applyLayoutCommand({
      ...ratios,
      root: { ...split, second: { type: 'leaf', leafId: 'another-leaf' } }
    })
    expect(reply).toEqual({ ok: false, code: 'pane_structure_changed' })
  })

  it('refuses a window split whose pane id another tab holds', () => {
    const window = new WindowSession(getDefaultWorkspaceSession())
    window.addTab(WORKTREE, TAB, LEAF_A)
    window.addTab(WORKTREE, 'tab-2', LEAF_B)

    const split = applyCommandToSession('local', window.snapshot(), {
      type: 'splitPane',
      workspace: WORKTREE,
      tabId: TAB,
      leafId: LEAF_A,
      direction: 'vertical',
      newLeafId: LEAF_B
    })

    expect(split).toEqual({ value: { ok: false, code: 'pane_in_other_tab' }, session: null })
  })
})
