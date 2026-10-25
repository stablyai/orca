// A diff tab's in-memory view through session changes no layout apply makes: a partition move
// carries the view to the tab's new partition, a removal drops it, and a failed write restores it.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import { hostWorktreeTarget } from '../../shared/worktree/host-qualified-identity'
import type { LayoutEditorView } from '../../shared/workspace-layout/layout-editor-view'
import type { Store } from '../persistence/loading-store/store'
import { WindowSession } from '../persistence/terminal-topology/terminal-topology-window-session-fixture'
import {
  emptyTerminalSessionProfile,
  FIXTURE_FOLDER_WORKTREE_ID as FOLDER,
  FIXTURE_GIT_WORKTREE_ID as WT,
  openTopologyStoreWithAuthority
} from '../persistence/terminal-topology/terminal-topology-profile-fixture'
import { OrcaRuntimeService } from './orca-runtime'

vi.mock('../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))
vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../ssh/config/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))

const SSH_HOST = 'ssh:target-1'
const MOVED_HOST = 'ssh:target-2'
const SSH_WORKTREE = 'repo-ssh::/home/dev/api'
const DIFF_VIEW: LayoutEditorView = {
  view: { mode: 'diff', diffSource: 'unstaged' },
  file: { filePath: '/home/dev/api/a.ts', relativePath: 'a.ts', language: 'typescript' }
}
const directories: string[] = []
const stores: Store[] = []

afterEach(async () => {
  for (const store of stores.splice(0)) {
    await store.freezeWritesAsync()
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

async function harness() {
  const directory = mkdtempSync(join(tmpdir(), 'orca-editor-view-partition-'))
  directories.push(directory)
  const { store, authority } = await openTopologyStoreWithAuthority(
    directory,
    emptyTerminalSessionProfile()
  )
  stores.push(store)
  const window = new WindowSession(getDefaultWorkspaceSession())
  window.addTab(WT, 'term-1', '11111111-1111-4111-8111-111111111111')
  window.addTab(FOLDER, 'term-2', '22222222-2222-4222-8222-222222222222')
  store.setWorkspaceSession(window.snapshot())
  await store.flushPendingOrThrowAsync()
  const runtime = new OrcaRuntimeService(store)
  const subscription = runtime.subscribeWorkspaceLayouts(() => {})
  return { store, authority, runtime, subscription }
}

function openDiff(workspace: string, tabId: string) {
  return {
    type: 'openEditorTab',
    workspace,
    tabId,
    fileId: `diff::unstaged::${DIFF_VIEW.file.filePath}`,
    contentType: 'diff',
    groupId: `group-${workspace}`,
    view: DIFF_VIEW
  } as const
}

/** The editor tab main's layout stream publishes for `tabId` in `workspace` now. */
function publishedTab(runtime: OrcaRuntimeService, workspace: string, tabId: string) {
  const reader = runtime.subscribeWorkspaceLayouts(() => {})
  reader.unsubscribe()
  const layout = reader.snapshot.find(({ key }) => key === workspace)?.layout
  return layout?.tabs.find((tab) => tab.id === tabId)
}

describe("main's Store keeps an editor view where its tab's session is", () => {
  it('a partition move carries the view to the new partition, which publishes it', async () => {
    const { store, runtime, subscription } = await harness()
    // The SSH repo routes its workspace to the SSH partition's layout.
    store.addRepo({
      id: 'repo-ssh',
      path: '/home/dev/api',
      displayName: 'api',
      badgeColor: '#fff',
      addedAt: 1,
      connectionId: 'target-1'
    })
    expect((await store.applyLayoutCommand(openDiff(SSH_WORKTREE, 'd1'), [SSH_HOST])).ok).toBe(true)
    expect(publishedTab(runtime, SSH_WORKTREE, 'd1')?.editorView).toEqual(DIFF_VIEW)

    store.reassignSshTargetId('target-1', 'target-2')

    expect(store.getWorkspaceSession(MOVED_HOST).unifiedTabs?.[SSH_WORKTREE]).toEqual([
      expect.objectContaining({ id: 'd1' })
    ])
    expect(publishedTab(runtime, SSH_WORKTREE, 'd1')?.editorView).toEqual(DIFF_VIEW)
    expect(store.getLayoutEditorViews(SSH_HOST)).toBeUndefined()
    expect(store.getLayoutEditorViews(MOVED_HOST)).toEqual({ [SSH_WORKTREE]: { d1: DIFF_VIEW } })
    subscription.unsubscribe()
  })

  it('a removed workspace or partition keeps no view', async () => {
    const { store, subscription } = await harness()
    await store.applyLayoutCommand(openDiff(WT, 'd1'))
    await store.applyLayoutCommand(openDiff(FOLDER, 'd2'))
    await store.applyLayoutCommand(openDiff(SSH_WORKTREE, 'd3'), [SSH_HOST])

    store.removeWorkspaceSessionStateForWorktree(hostWorktreeTarget({ id: WT, hostId: 'local' }))
    expect(store.getLayoutEditorViews('local')).toEqual({ [FOLDER]: { d2: DIFF_VIEW } })

    store.removeWorkspaceSessionHost(SSH_HOST)
    expect(store.getLayoutEditorViews(SSH_HOST)).toBeUndefined()
    subscription.unsubscribe()
  })

  it('a failed write puts a workspace move back with its view', async () => {
    const { store, authority, runtime, subscription } = await harness()
    await runtime.applyLayoutCommand(openDiff(WT, 'd1'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    authority.failNextWrite()

    await expect(
      store.applyLayoutCommand({
        type: 'moveTabToWorkspace',
        workspace: WT,
        toWorkspace: FOLDER,
        tabs: [{ tabId: 'd1', newTabId: 'd1-moved', newEntityId: 'diff::moved' }],
        groupId: `group-${FOLDER}`
      })
    ).rejects.toThrow()

    expect(store.getLayoutEditorViews('local')).toEqual({ [WT]: { d1: DIFF_VIEW } })
    expect(publishedTab(runtime, WT, 'd1')?.editorView).toEqual(DIFF_VIEW)
    expect(publishedTab(runtime, FOLDER, 'd1-moved')).toBeUndefined()
    subscription.unsubscribe()
  })

  it('a failed write puts a move across partitions back with its view', async () => {
    const { store, authority, subscription } = await harness()
    await store.applyLayoutCommand(openDiff(WT, 'd1'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    authority.failNextWrite()

    await expect(
      store.moveTabToWorkspaceAcrossPartitions(
        {
          type: 'moveTabToWorkspace',
          workspace: WT,
          toWorkspace: SSH_WORKTREE,
          tabs: [{ tabId: 'd1', newTabId: 'd1', newEntityId: 'diff::moved' }],
          groupId: `group-${SSH_WORKTREE}`
        },
        'local',
        SSH_HOST
      )
    ).rejects.toThrow()

    expect(store.getLayoutEditorViews('local')).toEqual({ [WT]: { d1: DIFF_VIEW } })
    expect(store.getLayoutEditorViews(SSH_HOST) ?? {}).toEqual({})
    subscription.unsubscribe()
  })
})
