import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../shared/layout-owner-switch'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import type { CommandOf } from '../../../shared/workspace-layout/workspace-layout-command-types'
import { WorkspaceLayoutStream } from '../../runtime/workspace-layout-stream'
import type { Store } from '../loading-store/store'
import { WindowSession } from './terminal-topology-window-session-fixture'
import {
  emptyTerminalSessionProfile,
  FIXTURE_FOLDER_WORKTREE_ID,
  FIXTURE_GIT_WORKTREE_ID,
  openTopologyStore,
  reopenTopologyStore
} from './terminal-topology-profile-fixture'

vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../ssh/config/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))

const SSH = 'ssh:target-1'
const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

const leafOf = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`

/** A store whose local partition holds `count` git-workspace tabs and one folder tab. */
async function storeWithTabs(count: number): Promise<{ store: Store; directory: string }> {
  const directory = mkdtempSync(join(tmpdir(), 'orca-rename-tabs-'))
  directories.push(directory)
  const store = await openTopologyStore(directory, emptyTerminalSessionProfile())
  const local = new WindowSession(getDefaultWorkspaceSession())
  for (let index = 0; index < count; index += 1) {
    local.addTab(FIXTURE_GIT_WORKTREE_ID, `tab-${index}`, leafOf(index))
  }
  local.addTab(FIXTURE_FOLDER_WORKTREE_ID, 'folder-tab', leafOf(count))
  store.setWorkspaceSession(local.snapshot())
  const ssh = new WindowSession(getDefaultWorkspaceSession())
  ssh.addTab(FIXTURE_GIT_WORKTREE_ID, 'ssh-tab', leafOf(count + 1))
  store.setWorkspaceSession(ssh.snapshot(), SSH)
  await store.flushPendingOrThrowAsync()
  return { store, directory }
}

const rename = (workspace: string, tabId: string, title: string): CommandOf<'renameTab'> => ({
  type: 'renameTab',
  workspace,
  tabId,
  kind: 'generated',
  title
})

const generatedTitles = (store: Store, hostId?: string) =>
  Object.values(store.getWorkspaceSession(hostId).tabsByWorktree)
    .flat()
    .map((tab) => [tab.id, tab.generatedTitle])

describe('Store.applyTabRenames (layout.apply renameTabs)', () => {
  it('renames tabs of several workspaces and partitions durably, naming the tab it lacks', async () => {
    const { store, directory } = await storeWithTabs(2)
    const written: (string | null)[] = []
    store.onWorkspaceSessionWritten((hostId) => written.push(hostId))

    const refused = await store.applyTabRenames([
      {
        hostId: 'local',
        renames: [
          rename(FIXTURE_GIT_WORKTREE_ID, 'tab-0', 'Fix the login page'),
          rename(FIXTURE_GIT_WORKTREE_ID, 'missing', 'Gone'),
          rename(FIXTURE_FOLDER_WORKTREE_ID, 'folder-tab', 'Write the docs')
        ]
      },
      { hostId: SSH, renames: [rename(FIXTURE_GIT_WORKTREE_ID, 'ssh-tab', 'Deploy')] }
    ])

    expect(refused).toEqual([
      { rename: rename(FIXTURE_GIT_WORKTREE_ID, 'missing', 'Gone'), code: 'tab_not_found' }
    ])
    // Both partitions in one durable mutation: one notice for any partition, or one per partition.
    expect(written).toEqual(ORCA_LAYOUT_OWNER_IS_MAIN ? ['local', SSH] : [null])
    const reopened = await reopenTopologyStore(store, directory)
    expect(generatedTitles(reopened)).toEqual([
      ['tab-0', 'Fix the login page'],
      ['tab-1', undefined],
      ['folder-tab', 'Write the docs']
    ])
    expect(generatedTitles(reopened, SSH)).toEqual([['ssh-tab', 'Deploy']])
  })

  it('publishes one frame for 100 titles of one workspace', async () => {
    const { store } = await storeWithTabs(100)
    const stream = new WorkspaceLayoutStream({
      store: () => store,
      homeHostId: () => 'local',
      liveTitle: () => null
    })
    const events: string[] = []
    stream.subscribe((event) =>
      events.push(
        ...(event.type === 'records'
          ? event.workspaces.map((change) => change.key)
          : [event.type === 'workspace' ? event.key : event.type])
      )
    )

    await store.applyTabRenames([
      {
        hostId: 'local',
        renames: Array.from({ length: 100 }, (_, index) =>
          rename(FIXTURE_GIT_WORKTREE_ID, `tab-${index}`, `Title ${index}`)
        )
      }
    ])
    stream.settledSeq()

    expect(events).toEqual([FIXTURE_GIT_WORKTREE_ID])
    expect(generatedTitles(store).at(99)).toEqual(['tab-99', 'Title 99'])
  })

  it('writes nothing when no rename changes a title', async () => {
    const { store } = await storeWithTabs(1)
    const before = store.getWorkspaceSession()

    const refused = await store.applyTabRenames([
      { hostId: 'local', renames: [rename(FIXTURE_GIT_WORKTREE_ID, 'missing', 'Gone')] }
    ])

    expect(refused.map(({ code }) => code)).toEqual(['tab_not_found'])
    expect(store.getWorkspaceSession()).toBe(before)
  })
  it('keeps a tab’s first generated title unless a rename replaces it', async () => {
    const { store, directory } = await storeWithTabs(1)
    await store.applyTabRenames([
      { hostId: 'local', renames: [rename(FIXTURE_GIT_WORKTREE_ID, 'tab-0', 'First prompt')] }
    ])

    const second = rename(FIXTURE_GIT_WORKTREE_ID, 'tab-0', 'Second prompt')
    expect(await store.applyTabRenames([{ hostId: 'local', renames: [second] }])).toEqual([
      { rename: second, code: 'generated_title_kept' }
    ])
    expect(generatedTitles(store)[0]).toEqual(['tab-0', 'First prompt'])

    const replacing: CommandOf<'renameTab'> = {
      type: 'renameTab',
      workspace: FIXTURE_GIT_WORKTREE_ID,
      tabId: 'tab-0',
      kind: 'generated',
      title: 'Replaced title',
      replaceExisting: true
    }
    expect(await store.applyTabRenames([{ hostId: 'local', renames: [replacing] }])).toEqual([])
    const reopened = await reopenTopologyStore(store, directory)
    expect(generatedTitles(reopened)[0]).toEqual(['tab-0', 'Replaced title'])
  })
})
