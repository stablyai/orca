import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../../shared/constants'
import type { CommandOf } from '../../../../shared/workspace-layout/workspace-layout-command-types'
import type { Store } from '../../loading-store/store'
import { WindowSession } from '../testing/terminal-topology-window-session-fixture'
import {
  emptyTerminalSessionProfile,
  FIXTURE_FOLDER_WORKTREE_ID,
  FIXTURE_GIT_WORKTREE_ID,
  openTopologyStore,
  reopenTopologyStore
} from '../testing/terminal-topology-profile-fixture'

vi.mock('../../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../../ssh/config/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))

const WORKTREE = FIXTURE_GIT_WORKTREE_ID
const GROUP = `group-${WORKTREE}`
const TAB = 'tab-1'
const LEAF = '11111111-1111-4111-8111-111111111111'
const NEW_TAB = 'tab-new'
const NEW_LEAF = '22222222-2222-4222-8222-222222222222'
const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

async function openStore(
  seed: (window: WindowSession) => void,
  hostId?: string
): Promise<{ store: Store; directory: string }> {
  const directory = mkdtempSync(join(tmpdir(), 'orca-layout-create-'))
  directories.push(directory)
  const store = await openTopologyStore(directory, emptyTerminalSessionProfile())
  const window = new WindowSession(getDefaultWorkspaceSession())
  seed(window)
  store.setWorkspaceSession(window.snapshot(), hostId)
  await store.flushPendingOrThrowAsync()
  return { store, directory }
}

const withOneTab = (window: WindowSession): void => {
  window.addTab(WORKTREE, TAB, LEAF)
  window.bind(TAB, LEAF, 'pty-1')
}

const create: CommandOf<'createTerminalTab'> = {
  type: 'createTerminalTab',
  workspace: WORKTREE,
  tabId: NEW_TAB,
  leafId: NEW_LEAF,
  groupId: GROUP,
  creation: { defaultTitle: 'Terminal 2', startupCwd: '/fixture/local/src' }
}

describe('Store.applyLayoutCommand: a window’s terminal tab create', () => {
  it('writes the tab durably under the window’s ids, in the group it names', async () => {
    const { store, directory } = await openStore(withOneTab)

    const reply = await store.applyLayoutCommand(create)

    expect(reply).toEqual({
      ok: true,
      result: { tabId: NEW_TAB, leafId: NEW_LEAF, paneKey: `${NEW_TAB}:${NEW_LEAF}` }
    })
    const session = (await reopenTopologyStore(store, directory)).getWorkspaceSession()
    expect(session.terminalLayoutsByTabId[NEW_TAB]?.root).toEqual({
      type: 'leaf',
      leafId: NEW_LEAF
    })
    const row = session.tabsByWorktree[WORKTREE]?.find((tab) => tab.id === NEW_TAB)
    expect(row).toMatchObject({ defaultTitle: 'Terminal 2', startupCwd: '/fixture/local/src' })
    expect(session.tabGroups?.[WORKTREE]?.[0]).toMatchObject({
      id: GROUP,
      tabOrder: [TAB, NEW_TAB]
    })
  })

  it('writes an SSH workspace’s tab into that host’s partition only', async () => {
    const { store } = await openStore(withOneTab, 'ssh:target-1')
    const local = store.getWorkspaceSession()

    const reply = await store.applyLayoutCommand(create, ['ssh:target-1'])

    expect(reply.ok).toBe(true)
    expect(store.getWorkspaceSession('ssh:target-1').terminalLayoutsByTabId[NEW_TAB]?.root).toEqual(
      { type: 'leaf', leafId: NEW_LEAF }
    )
    expect(store.getWorkspaceSession()).toEqual(local)
  })
})

describe('Store.applyLayoutCommand: a workspace’s default tabs', () => {
  const defaults: CommandOf<'applyDefaultTabs'> = {
    type: 'applyDefaultTabs',
    workspace: FIXTURE_FOLDER_WORKTREE_ID,
    tabs: [
      { tabId: NEW_TAB, leafId: NEW_LEAF, title: 'Server' },
      { tabId: 'tab-new-2', leafId: '33333333-3333-4333-8333-333333333333', color: 'blue' }
    ]
  }

  it('writes every tab under the window’s ids with the mark, durably, in one command', async () => {
    const { store, directory } = await openStore(withOneTab)

    const reply = await store.applyLayoutCommand(defaults)

    expect(reply.ok && reply.result.createdTabs?.map((tab) => tab.tabId)).toEqual([
      NEW_TAB,
      'tab-new-2'
    ])
    const session = (await reopenTopologyStore(store, directory)).getWorkspaceSession()
    expect(session.tabsByWorktree[FIXTURE_FOLDER_WORKTREE_ID]?.map((tab) => tab.id)).toEqual([
      NEW_TAB,
      'tab-new-2'
    ])
    expect(session.defaultTerminalTabsAppliedByWorktreeId?.[FIXTURE_FOLDER_WORKTREE_ID]).toBe(true)
  })
})
