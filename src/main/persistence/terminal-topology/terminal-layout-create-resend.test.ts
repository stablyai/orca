import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import type { CommandOf } from '../../../shared/workspace-layout/workspace-layout-command-types'
import { collectLeafIds } from '../../../shared/terminal-pane-layout-tree'
import type { Store } from '../loading-store/store'
import { _resetClosedPaneFencesForTests } from './closed-pane-binding-fence'
import { WindowSession } from './terminal-topology-window-session-fixture'
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
const NEW_TAB = 'tab-new'
const NEW_LEAF = '22222222-2222-4222-8222-222222222222'
const directories: string[] = []

afterEach(() => {
  _resetClosedPaneFencesForTests()
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

async function openStore(): Promise<Store> {
  const directory = mkdtempSync(join(tmpdir(), 'orca-layout-resend-'))
  directories.push(directory)
  const store = await openTopologyStore(directory, emptyTerminalSessionProfile())
  const window = new WindowSession(getDefaultWorkspaceSession())
  window.addTab(WORKTREE, TAB, LEAF)
  window.bind(TAB, LEAF, 'pty-1')
  store.setWorkspaceSession(window.snapshot())
  await store.flushPendingOrThrowAsync()
  return store
}

const SPLIT_LEAF = '33333333-3333-4333-8333-333333333333'

function leafIds(store: Store): string[] {
  return collectLeafIds(store.getWorkspaceSession().terminalLayoutsByTabId[NEW_TAB]?.root)
}

const create: CommandOf<'createTerminalTab'> = {
  type: 'createTerminalTab',
  workspace: WORKTREE,
  tabId: NEW_TAB,
  leafId: NEW_LEAF
}

describe('layout-owner build: a create sent again after its close', () => {
  it('refuses a tab main recorded closed, and writes nothing', async () => {
    const store = await openStore()
    await store.applyLayoutCommand(create)
    await store.applyLayoutCommand({
      type: 'closeTabs',
      workspace: WORKTREE,
      tabIds: [NEW_TAB],
      recordClose: 'user'
    })
    const before = store.getWorkspaceSession()

    expect(await store.applyLayoutCommand(create)).toEqual({ ok: false, code: 'tab_closed' })
    expect(store.getWorkspaceSession()).toBe(before)
  })

  // No sender replays a sent layout.apply create (PR body: sender table); a pane create lifts the
  // closed-pane fence by design, so a replayed split brings its pane back.
  it('lets a replayed split bring back a pane main closed: pane creates are not deduped', async () => {
    const store = await openStore()
    await store.applyLayoutCommand(create)
    const split: CommandOf<'splitPane'> = {
      type: 'splitPane',
      workspace: WORKTREE,
      tabId: NEW_TAB,
      leafId: NEW_LEAF,
      direction: 'vertical',
      newLeafId: SPLIT_LEAF
    }
    await store.applyLayoutCommand(split)
    await store.applyLayoutCommand({
      type: 'closePane',
      workspace: WORKTREE,
      tabId: NEW_TAB,
      leafId: SPLIT_LEAF
    })
    expect(leafIds(store)).toEqual([NEW_LEAF])

    expect((await store.applyLayoutCommand(split)).ok).toBe(true)
    expect(leafIds(store)).toEqual([NEW_LEAF, SPLIT_LEAF])
  })
})
