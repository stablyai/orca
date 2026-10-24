import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../shared/layout-owner-switch'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import { diffStoredSession } from '../../../shared/workspace-layout/workspace-layout-load-report'
import { LEGACY_WORKSPACE_LAYOUT_PROFILES } from '../../../shared/workspace-layout/workspace-layout-legacy-profile.test-fixture'
import { WORKSPACE_LAYOUT_PROFILES } from '../../../shared/workspace-layout/workspace-layout-profile.test-fixture'
import {
  closeTerminalSurfaceInWorkspaceSession,
  collectTerminalLayoutLeafIds
} from '../../runtime/terminal-surface-close'
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

/** What only the legacy close writes, which no reader distinguishes from its absence. */
function legacyOnly(change: ReturnType<typeof diffStoredSession>[number]): boolean {
  if (change.table !== 'session') {
    return false
  }
  // The legacy close re-derives the active tab's type; layout.apply leaves selection alone.
  if (change.field === 'activeTabTypeByWorktree') {
    return true
  }
  // An empty tombstone map where none was stored.
  return (
    change.field === 'terminalSurfaceTombstonesByPaneKey' &&
    change.after === undefined &&
    JSON.stringify(change.before) === '{}'
  )
}

/**
 * Known gap, the same one the record-patch test pins: the load folds this legacy row into the
 * tab-bar tab whose terminal it repeats, so the stored row keeps its terminal id after the close.
 */
/** Layout-owner builds also record the closed pane's terminal for its exit (L80); the legacy close cannot. */
function layoutOwnerOnly(change: ReturnType<typeof diffStoredSession>[number]): boolean {
  return (
    ORCA_LAYOUT_OWNER_IS_MAIN &&
    change.table === 'session' &&
    change.field === 'closedTerminalPanesByPaneKey'
  )
}

const FOLDED_LEGACY_ROW_CLOSES = new Map([
  [
    'tab-legacy',
    ['row/repo-1::/Users/dev/orca|tab-legacy/ptyId', 'layout/tab-legacy/ptyIdsByLeafId']
  ]
])

describe('layout.apply closePane against the legacy pane close', () => {
  const profiles = [...WORKSPACE_LAYOUT_PROFILES, ...LEGACY_WORKSPACE_LAYOUT_PROFILES]

  it.each(profiles.map((profile) => [profile.name, profile] as const))(
    '%s: writes what the legacy close writes, and refuses a tab’s last pane',
    (_name, profile) => {
      const stored = profile.build()
      for (const [worktreeId, tabs] of Object.entries(stored.tabsByWorktree)) {
        for (const tab of tabs) {
          const panes = collectTerminalLayoutLeafIds(stored.terminalLayoutsByTabId[tab.id]?.root)
          for (const leafId of panes) {
            const target = { kind: 'pane', tabId: tab.id, leafId } as const
            const legacy = closeTerminalSurfaceInWorkspaceSession(stored, worktreeId, target, {
              reason: 'user'
            })
            const dark = applyCommandToSession(profile.hostId, stored, {
              type: 'closePane',
              workspace: worktreeId,
              tabId: tab.id,
              leafId,
              userPaneClose: true
            })
            const label = `${tab.id}:${leafId}`
            if (legacy.resolution !== 'pane') {
              // The legacy close changes nothing here; nor may layout.apply (a refusal or no-op).
              expect(dark.session, label).toBeNull()
              continue
            }
            expect(dark.value.ok, label).toBe(true)
            const differences = diffStoredSession(legacy.session, dark.session ?? stored)
              .filter((change) => !legacyOnly(change) && !layoutOwnerOnly(change))
              .map(({ table, record, field }) => `${table}/${record}/${field}`)
            expect(differences, label).toEqual(FOLDED_LEGACY_ROW_CLOSES.get(tab.id) ?? [])
          }
        }
      }
    }
  )

  // The legacy persisted close refuses a pane restarted after the request, but the window has
  // already removed it and saves its layout without it; main closes it outright.
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

  it('saves a pane title as the window saves it, and clears it on null', async () => {
    const store = await storeWithSplitTab(['local'])
    const rename = { type: 'renamePane', workspace: WORKTREE, tabId: TAB, leafId: LEAF_B } as const

    await store.applyLayoutCommand({ ...rename, title: 'Server' })
    expect(store.getWorkspaceSession().terminalLayoutsByTabId[TAB]?.titlesByLeafId).toEqual({
      [LEAF_B]: 'Server'
    })

    await store.applyLayoutCommand({ ...rename, title: null })
    expect(store.getWorkspaceSession().terminalLayoutsByTabId[TAB]?.titlesByLeafId ?? {}).toEqual(
      {}
    )
  })

  it('equalizes as the window saves an even split: no ratio', async () => {
    const store = await storeWithSplitTab(['local'])

    await store.applyLayoutCommand({ type: 'equalizePanes', workspace: WORKTREE, tabId: TAB })

    expect(store.getWorkspaceSession().terminalLayoutsByTabId[TAB]?.root).toEqual({
      type: 'split',
      direction: 'vertical',
      first: { type: 'leaf', leafId: LEAF_A },
      second: { type: 'leaf', leafId: LEAF_B }
    })
  })

  it('moves a pane as the window drops it: the new split starts even', async () => {
    const store = await storeWithSplitTab(['local'])

    await store.applyLayoutCommand({
      type: 'movePane',
      workspace: WORKTREE,
      tabId: TAB,
      leafId: LEAF_B,
      targetLeafId: LEAF_A,
      side: 'left'
    })

    expect(store.getWorkspaceSession().terminalLayoutsByTabId[TAB]?.root).toEqual({
      type: 'split',
      direction: 'vertical',
      first: { type: 'leaf', leafId: LEAF_B },
      second: { type: 'leaf', leafId: LEAF_A }
    })
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

  it('records a split under the window’s pane id once, and refuses an id another tab holds', async () => {
    const store = await storeWithSplitTab(['local'])
    const LEAF_C = '33333333-3333-4333-8333-333333333333'
    const split = {
      type: 'splitPane',
      workspace: WORKTREE,
      tabId: TAB,
      leafId: LEAF_B,
      direction: 'horizontal',
      newLeafId: LEAF_C
    } as const

    expect(await store.applyLayoutCommand(split)).toMatchObject({
      ok: true,
      result: { leafId: LEAF_C }
    })
    const written = store.getWorkspaceSession()
    expect(await store.applyLayoutCommand(split)).toMatchObject({
      ok: true,
      result: { leafId: LEAF_C }
    })
    expect(store.getWorkspaceSession()).toEqual(written)
    expect(leafIds(written.terminalLayoutsByTabId[TAB]?.root)).toEqual([LEAF_A, LEAF_B, LEAF_C])
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
