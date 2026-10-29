// Layout apply reloads saved sessions; retain editor views, which exist only in memory.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { LayoutEditorView } from '../../shared/workspace-layout/layout-editor-view'
import type { Store } from '../persistence/loading-store/store'
import { WindowSession } from '../persistence/terminal-topology/terminal-topology-window-session-fixture'
import {
  emptyTerminalSessionProfile,
  FIXTURE_FOLDER_WORKTREE_ID as FOLDER,
  FIXTURE_GIT_WORKTREE_ID as WT,
  openTopologyStore,
  reopenTopologyStore
} from '../persistence/terminal-topology/terminal-topology-profile-fixture'
import { OrcaRuntimeService } from './orca-runtime'

vi.mock('../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))
vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../ssh/config/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))

const GROUP = `group-${WT}`
const DIFF_VIEW: LayoutEditorView = {
  view: { mode: 'diff', diffSource: 'unstaged', branchOldPath: 'view-only-marker.ts' },
  file: { filePath: '/fixture/local/a.ts', relativePath: 'a.ts', language: 'typescript' }
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
  const directory = mkdtempSync(join(tmpdir(), 'orca-editor-view-apply-'))
  directories.push(directory)
  const store = await openTopologyStore(directory, emptyTerminalSessionProfile())
  stores.push(store)
  const window = new WindowSession(getDefaultWorkspaceSession())
  window.addTab(WT, 'term-1', '11111111-1111-4111-8111-111111111111')
  window.addTab(FOLDER, 'term-2', '22222222-2222-4222-8222-222222222222')
  store.setWorkspaceSession(window.snapshot())
  await store.flushPendingOrThrowAsync()
  const runtime = new OrcaRuntimeService(store)
  const subscription = runtime.subscribeWorkspaceLayouts(() => {})
  return { store, runtime, directory, subscription }
}

function openDiff(tabId: string) {
  return {
    type: 'openEditorTab',
    workspace: WT,
    tabId,
    fileId: 'diff::unstaged::/fixture/local/a.ts',
    contentType: 'diff',
    groupId: GROUP,
    preview: true,
    view: DIFF_VIEW
  } as const
}

function openFile(tabId: string, path: string) {
  return {
    type: 'openEditorTab',
    workspace: WT,
    tabId,
    fileId: path,
    contentType: 'editor',
    groupId: GROUP,
    file: { filePath: path, relativePath: path.slice(1), language: 'typescript' }
  } as const
}

function publishedView(runtime: OrcaRuntimeService, tabId: string, workspace = WT) {
  const reader = runtime.subscribeWorkspaceLayouts(() => {})
  reader.unsubscribe()
  const layout = reader.snapshot.find(({ key }) => key === workspace)?.layout
  return layout?.tabs.find((tab) => tab.id === tabId)?.editorView
}

describe("main's Store apply keeps an editor tab's in-memory view", () => {
  it('publishes the view after the open and after a later command', async () => {
    const { runtime, subscription } = await harness()

    expect((await runtime.applyLayoutCommand(openDiff('d1'))).ok).toBe(true)
    expect(publishedView(runtime, 'd1')).toEqual(DIFF_VIEW)

    expect((await runtime.applyLayoutCommand(openFile('e1', '/fixture/local/b.ts'))).ok).toBe(true)
    expect(publishedView(runtime, 'd1')).toEqual(DIFF_VIEW)
    subscription.unsubscribe()
  })

  it('a view-only re-send sticks, a close drops it, and no view reaches disk', async () => {
    const { store, runtime, directory, subscription } = await harness()
    await runtime.applyLayoutCommand({ ...openDiff('d1'), preview: undefined })
    const later: LayoutEditorView = {
      ...DIFF_VIEW,
      view: { mode: 'diff', diffSource: 'staged' }
    }
    await runtime.applyLayoutCommand({ ...openDiff('d1'), preview: undefined, view: later })
    expect(publishedView(runtime, 'd1')).toEqual(later)

    await runtime.applyLayoutCommand({ type: 'closeTabs', workspace: WT, tabIds: ['d1'] })
    expect(publishedView(runtime, 'd1')).toBeUndefined()
    await runtime.applyLayoutCommand({ ...openDiff('d2'), preview: undefined })
    expect(JSON.stringify(store.getWorkspaceSession())).not.toContain('view-only-marker')
    const reopened = await reopenTopologyStore(store, directory)
    stores.push(reopened)
    expect(JSON.stringify(reopened.getWorkspaceSession())).not.toContain('view-only-marker')
    subscription.unsubscribe()
  })

  it('a rename and a move to another workspace carry the view', async () => {
    const { runtime, subscription } = await harness()
    await runtime.applyLayoutCommand({ ...openDiff('d1'), preview: undefined })

    const renamed = await runtime.applyLayoutCommand({
      type: 'renameEditorFiles',
      workspace: WT,
      renames: [{ fileId: openDiff('d1').fileId, newFileId: 'diff::unstaged::/fixture/local/c.ts' }]
    })
    expect(renamed.ok).toBe(true)
    expect(publishedView(runtime, 'd1')).toEqual(DIFF_VIEW)

    const moved = await runtime.applyLayoutCommand({
      type: 'moveTabToWorkspace',
      workspace: WT,
      toWorkspace: FOLDER,
      tabs: [{ tabId: 'd1', newTabId: 'd1-moved', newEntityId: 'diff::moved' }],
      groupId: `group-${FOLDER}`
    })
    expect(moved.ok).toBe(true)
    expect(publishedView(runtime, 'd1')).toBeUndefined()
    expect(publishedView(runtime, 'd1-moved', FOLDER)).toEqual(DIFF_VIEW)
    subscription.unsubscribe()
  })
})
