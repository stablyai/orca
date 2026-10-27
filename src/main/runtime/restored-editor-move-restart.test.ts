// A restored-editor move must survive real Store save and cold restart, including its file record only in the destination.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import { ownedEditorFileId } from '../../shared/workspace-session-pane-ownership'
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

const FILE_PATH = '/fixture/local/folder/a.ts'
const MOVED_ID = ownedEditorFileId(FILE_PATH, FOLDER, null)
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

/** A git worktree and a folder workspace, one terminal each, saved by a window. */
async function harness() {
  const directory = mkdtempSync(join(tmpdir(), 'orca-restored-editor-move-'))
  directories.push(directory)
  const store = await openTopologyStore(directory, emptyTerminalSessionProfile())
  stores.push(store)
  const window = new WindowSession(getDefaultWorkspaceSession())
  window.addTab(WT, 'term-1', '11111111-1111-4111-8111-111111111111')
  window.addTab(FOLDER, 'term-2', '22222222-2222-4222-8222-222222222222')
  store.setWorkspaceSession(window.snapshot())
  await store.flushPendingOrThrowAsync()
  return { store, directory }
}

/** Main's published layout of every workspace, as a window's frame sync starts from it. */
function published(runtime: OrcaRuntimeService) {
  const reader = runtime.subscribeWorkspaceLayouts(() => {})
  reader.unsubscribe()
  return new Map(reader.snapshot.map(({ key, layout }) => [key, layout]))
}

describe('an editor tab Orca moved survives restart', () => {
  it('main loads the moved tab and its file record in the new workspace only', async () => {
    const { store, directory } = await harness()
    const runtime = new OrcaRuntimeService(store)
    const subscription = runtime.subscribeWorkspaceLayouts(() => {})
    const opened = await runtime.applyLayoutCommand({
      type: 'openEditorTab',
      workspace: WT,
      tabId: 'e1',
      fileId: FILE_PATH,
      contentType: 'editor',
      groupId: `group-${WT}`,
      file: { filePath: FILE_PATH, relativePath: 'folder/a.ts', language: 'typescript' }
    })
    expect(opened.ok).toBe(true)

    const moved = await runtime.applyLayoutCommand({
      type: 'moveTabToWorkspace',
      workspace: WT,
      toWorkspace: FOLDER,
      tabs: [{ tabId: 'e1', newTabId: 'e1', newEntityId: MOVED_ID }],
      groupId: `group-${FOLDER}`,
      file: { filePath: FILE_PATH, relativePath: 'a.ts', language: 'typescript' }
    })
    expect(moved).toMatchObject({ ok: true, result: { tabId: 'e1' } })
    subscription.unsubscribe()

    const reopened = await reopenTopologyStore(store, directory)
    stores.push(reopened)
    const saved = reopened.getWorkspaceSession()
    expect(saved.openFilesByWorktree?.[FOLDER]).toEqual([
      expect.objectContaining({ filePath: FILE_PATH, relativePath: 'a.ts', worktreeId: FOLDER })
    ])
    expect(saved.openFilesByWorktree?.[WT] ?? []).toEqual([])

    const layouts = published(new OrcaRuntimeService(reopened))
    const editorTabs = [...layouts].flatMap(([key, layout]) =>
      layout.tabs.filter((tab) => tab.kind === 'editor').map((tab) => ({ key, tab }))
    )
    expect(editorTabs).toEqual([
      { key: FOLDER, tab: expect.objectContaining({ id: 'e1', entityId: MOVED_ID }) }
    ])
    const folder = layouts.get(FOLDER)
    expect(folder?.groups.find((group) => group.id === `group-${FOLDER}`)?.tabIds).toEqual([
      'term-2',
      'e1'
    ])
    expect(folder?.editorFiles).toEqual([
      expect.objectContaining({ filePath: FILE_PATH, relativePath: 'a.ts' })
    ])
    expect(layouts.get(WT)?.editorFiles ?? []).toEqual([])
  })
})
