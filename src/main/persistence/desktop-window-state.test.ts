import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  let serial = 0
  class Contents extends EventEmitter {
    id = ++serial
    isDestroyed = (): boolean => false
    getType = (): string => 'window'
  }
  class Window {
    webContents = new Contents()
    static getFocusedWindow = () => null
  }
  return {
    BrowserWindow: Window,
    app: { getPath: () => testState.dir },
    safeStorage: { isEncryptionAvailable: () => false }
  }
})
vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn().mockReturnValue({}) }))
vi.mock('../ssh/config/ssh-config-parser', () => ({
  loadUserSshConfig: vi.fn(),
  sshConfigHostsToTargets: vi.fn()
}))

import { BrowserWindow } from 'electron'
import { closeTestStores, createStore, testState } from './persistence-test-harness'
import { getDefaultUIState, getDefaultWorkspaceSession } from '../../shared/constants'
import type { PersistedUIState } from '../../shared/persisted-ui-state-types'
import {
  addWorkspace,
  FOLDER_KEY,
  GIT_KEY,
  leaf,
  SSH_KEY
} from '../../shared/workspace-layout/workspace-layout-session.test-fixture'
import {
  listDesktopRenderers,
  registerDesktopRenderer,
  unregisterDesktopRenderer
} from '../window/desktop-renderer-registry'
import {
  desktopWindowSession,
  desktopWindowUI,
  saveDesktopWindowSessionView,
  updateDesktopWindowState,
  updateDesktopWindowUI
} from './desktop-window-state'
import { registerWslMoveDesktopWindowRewrite } from './moving-wsl-projects/wsl-move-desktop-windows'
import { resetWslMoveDesktopRewriteStoresForTests } from './moving-wsl-projects/wsl-move-desktop-rewrite-stores'
import { runWslMoveDesktopRewritePass } from './moving-wsl-projects/wsl-move-desktop-rewrite'
import { listWslMoveCutovers } from './moving-wsl-projects/wsl-move-cutover-journal'
import { wslMoveCutoverFixture } from './__fixtures__/wsl-mover/wsl-move-cutover-fixture'
import { seedWslMoveCutover } from './__fixtures__/wsl-mover/wsl-move-journal-seeding'
import { emptyLayoutViewRecord } from '../../shared/workspace-layout/workspace-layout-views'
import { ownedEditorFileId } from '../../shared/workspace-session-pane-ownership'
import { toRuntimeExecutionHostId } from '../../shared/execution-host'
import { worktreeWorkspaceKey } from '../../shared/workspace-scope'

let databaseDirectory: string | null = null

afterEach(async () => {
  resetWslMoveDesktopRewriteStoresForTests()
  for (const renderer of listDesktopRenderers()) {
    unregisterDesktopRenderer(renderer)
  }
  await closeTestStores()
  if (databaseDirectory) {
    rmSync(databaseDirectory, { recursive: true, force: true })
    databaseDirectory = null
  }
})

function fixture() {
  let ui = getDefaultUIState()
  let session = addWorkspace(getDefaultWorkspaceSession(), GIT_KEY, [
    { id: 'git-group', tabs: [{ id: 'git-tab', leaves: [[leaf(1), 'git-pty']] }] }
  ])
  session = addWorkspace(session, FOLDER_KEY, [
    { id: 'folder-group', tabs: [{ id: 'folder-tab', leaves: [[leaf(2), 'folder-pty']] }] }
  ])
  session.activeWorktreeId = GIT_KEY
  const first = new BrowserWindow({ show: false }).webContents
  const second = new BrowserWindow({ show: false }).webContents
  registerDesktopRenderer(first, 'first')
  registerDesktopRenderer(second, 'second')
  const store = {
    getUI: () => ui,
    updateUI: (updates: Partial<PersistedUIState>) => {
      ui = { ...ui, ...updates }
    },
    getWorkspaceSession: () => session
  }
  return { first, second, store, session }
}

describe('native desktop window persistence', () => {
  function wslMoveFixture() {
    databaseDirectory = mkdtempSync(join(tmpdir(), 'orca-desktop-window-wsl-'))
    testState.dir = databaseDirectory
    const store = createStore()
    const sourceKey = 'repo-1::\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo-1'
    const targetKey = 'repo-1::/home/dev/repo-1'
    const sourceFile = '\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo-1\\notes.md'
    const targetFile = '/home/dev/repo-1/notes.md'
    const sourceFileId = ownedEditorFileId(sourceFile, sourceKey, null)
    const targetFileId = ownedEditorFileId(targetFile, targetKey, 'wsl:Ubuntu')
    const host = toRuntimeExecutionHostId('wsl:Ubuntu')
    const draft = { dirtyDraftContent: `Keep user text: ${sourceFile}` }
    const session = addWorkspace(getDefaultWorkspaceSession(), sourceKey, [
      {
        id: 'g',
        tabs: [{ id: 'terminal-1', leaves: [[leaf(1)]] }]
      }
    ])
    session.openFilesByWorktree = {
      [sourceKey]: [
        {
          filePath: sourceFile,
          relativePath: 'notes.md',
          worktreeId: sourceKey,
          language: 'markdown'
        }
      ]
    }
    store.setWorkspaceSession(session)
    updateDesktopWindowState(store, 'first', {
      ui: { lastActiveWorktreeId: `local|${sourceKey}` },
      bounds: { x: 20, y: 30, width: 1000, height: 700 },
      viewsByHostId: {
        local: {
          ...emptyLayoutViewRecord(),
          activeRepoId: 'repo-1',
          activeWorktreeId: sourceKey,
          activeWorkspaceKey: worktreeWorkspaceKey(sourceKey),
          activeWorkspaceExecutionHostId: 'local',
          activeTabId: 'terminal-1',
          groups: {
            [sourceKey]: { g: { activeTabId: sourceFileId, recentTabIds: [sourceFileId] } },
            [FOLDER_KEY]: { f: { activeTabId: 'folder-tab' } },
            [GIT_KEY.replace('repo-1', 'repo-other')]: { other: { activeTabId: 'other-tab' } }
          },
          editorDrafts: { [sourceKey]: { [ownedEditorFileId(sourceFile, '', null)]: draft } },
          activeFileIdByWorktree: { [sourceKey]: sourceFileId },
          activeGroupIdByWorktree: { [sourceKey]: 'g' },
          lastVisitedAtByWorktreeId: { [`local|${sourceKey}`]: 42 }
        },
        'ssh:peer': { ...emptyLayoutViewRecord(), activeWorktreeId: sourceKey }
      }
    })
    updateDesktopWindowState(store, 'closed', {
      open: false,
      ui: { lastActiveWorktreeId: FOLDER_KEY },
      viewsByHostId: {
        local: {
          ...emptyLayoutViewRecord(),
          activeWorkspaceKey: FOLDER_KEY,
          activeWorkspaceExecutionHostId: 'local',
          activeTabId: 'folder-tab'
        }
      }
    })
    updateDesktopWindowState(store, 'unrelated', {
      ui: { lastActiveWorktreeId: 'ssh:peer|repo-1::/home/dev/repo-1' },
      viewsByHostId: { local: emptyLayoutViewRecord() }
    })
    const cutover = wslMoveCutoverFixture(
      'desktop-window-move',
      'destination-committed',
      {},
      {
        folderWorkspaceIds: ['notes-1']
      }
    )
    seedWslMoveCutover(databaseDirectory, cutover)
    registerWslMoveDesktopWindowRewrite(store)
    return {
      store,
      userDataPath: databaseDirectory,
      sourceKey,
      targetKey,
      sourceFile,
      targetFile,
      targetFileId,
      host,
      draft
    }
  }

  it('moves pane and file selections even when the window has no workspace group or active owner', async () => {
    const { store, userDataPath, sourceFile, targetFile, host } = wslMoveFixture()
    const fileId = ownedEditorFileId(sourceFile, '', null)
    updateDesktopWindowState(store, 'first', {
      ui: {},
      viewsByHostId: {
        local: {
          ...emptyLayoutViewRecord(),
          panes: { 'terminal-1': { activeLeafId: leaf(1), expandedLeafId: null } },
          markdownFrontmatterVisible: { [fileId]: true }
        }
      }
    })
    await runWslMoveDesktopRewritePass({ userDataPath })
    expect(listWslMoveCutovers(userDataPath)[0]?.rewrittenStores).toEqual(['desktopWindows'])
    const windows = store.getUI().desktopWindows
    expect(windows?.first?.viewsByHostId?.[host]?.panes['terminal-1']?.activeLeafId).toBe(leaf(1))
    expect(windows?.first?.viewsByHostId?.[host]?.markdownFrontmatterVisible).toEqual({
      [ownedEditorFileId(targetFile, '', 'wsl:Ubuntu')]: true
    })
    expect(windows?.first?.viewsByHostId?.local?.panes).toEqual({})
  })

  it('durably rewrites every scoped window view while preserving other hosts, projects and geometry', async () => {
    const { store, userDataPath, sourceKey, targetKey, targetFileId, host, draft } =
      wslMoveFixture()
    const before = structuredClone(store.getUI().desktopWindows)
    await runWslMoveDesktopRewritePass({ userDataPath })
    expect(listWslMoveCutovers(userDataPath)[0]?.rewrittenStores).toEqual(['desktopWindows'])
    await closeTestStores()
    const windows = createStore().getUI().desktopWindows
    expect(windows?.first?.ui?.lastActiveWorktreeId).toBe(`${host}|${targetKey}`)
    expect(windows?.first?.bounds).toEqual(before?.first?.bounds)
    expect(windows?.first?.viewsByHostId?.['ssh:peer']).toEqual(
      before?.first?.viewsByHostId?.['ssh:peer']
    )
    expect(windows?.unrelated).toEqual(before?.unrelated)
    const view = windows?.first?.viewsByHostId?.[host]
    expect(view?.activeWorkspaceExecutionHostId).toBe(host)
    expect(view?.activeWorkspaceKey).toBe(worktreeWorkspaceKey(targetKey))
    expect(view?.activeWorktreeId).toBe(targetKey)
    expect(view?.activeFileIdByWorktree?.[targetKey]).toBe(targetFileId)
    expect(view?.groups[targetKey]?.g?.activeTabId).toBe(targetFileId)
    expect(view?.editorDrafts[targetKey]).toEqual({
      [ownedEditorFileId('/home/dev/repo-1/notes.md', '', 'wsl:Ubuntu')]: draft
    })
    expect(view?.lastVisitedAtByWorktreeId?.[`${host}|${targetKey}`]).toBe(42)
    expect(view?.groups[FOLDER_KEY]).toEqual({ f: { activeTabId: 'folder-tab' } })
    expect(windows?.first?.viewsByHostId?.local?.groups[sourceKey]).toBeUndefined()
    expect(
      windows?.first?.viewsByHostId?.local?.groups[GIT_KEY.replace('repo-1', 'repo-other')]
    ).toEqual({
      other: { activeTabId: 'other-tab' }
    })
    expect(windows?.closed?.open).toBe(false)
    expect(windows?.closed?.ui?.lastActiveWorktreeId).toBe(`${host}|${FOLDER_KEY}`)
    expect(windows?.closed?.viewsByHostId?.[host]?.activeWorkspaceKey).toBe(FOLDER_KEY)
  })

  it('retries an unflushed window rewrite without duplicating or losing moved views', async () => {
    const { store, userDataPath } = wslMoveFixture()
    const flush = vi
      .spyOn(store, 'flushPendingOrThrowAsync')
      .mockRejectedValueOnce(new Error('disk full'))
    const warn = vi.fn()
    await runWslMoveDesktopRewritePass({ userDataPath, warn })
    expect(listWslMoveCutovers(userDataPath)[0]?.rewrittenStores).toEqual([])
    const afterFirstPass = structuredClone(store.getUI().desktopWindows)
    await runWslMoveDesktopRewritePass({ userDataPath, warn })
    expect(flush).toHaveBeenCalledTimes(2)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(listWslMoveCutovers(userDataPath)[0]?.rewrittenStores).toEqual(['desktopWindows'])
    expect(store.getUI().desktopWindows).toEqual(afterFirstPass)
  })

  it('refuses conflicting destination views before changing persisted window state', async () => {
    const { store, userDataPath, host, targetKey } = wslMoveFixture()
    const current = store.getUI().desktopWindows?.first
    updateDesktopWindowState(store, 'first', {
      viewsByHostId: {
        ...current?.viewsByHostId,
        [host]: {
          ...emptyLayoutViewRecord(),
          groups: { [targetKey]: { existing: { activeTabId: 'keep-me' } } }
        }
      }
    })
    const before = structuredClone(store.getUI().desktopWindows)
    const warn = vi.fn()
    await runWslMoveDesktopRewritePass({ userDataPath, warn })
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('wsl_move_desktop_window_view_collision')
    )
    expect(listWslMoveCutovers(userDataPath)[0]?.rewrittenStores).toEqual([])
    expect(store.getUI().desktopWindows).toEqual(before)
  })

  it('reads each window selection and geometry back from the SQLite profile after reopening', async () => {
    const { first, second } = fixture()
    databaseDirectory = mkdtempSync(join(tmpdir(), 'orca-desktop-window-'))
    testState.dir = databaseDirectory
    const store = createStore()
    updateDesktopWindowUI(store, first, { lastActiveWorktreeId: GIT_KEY, uiZoomLevel: 1 })
    updateDesktopWindowUI(store, second, { lastActiveWorktreeId: FOLDER_KEY, uiZoomLevel: -1 })
    updateDesktopWindowState(store, 'second', {
      bounds: { x: 80, y: 100, width: 1100, height: 800 },
      open: false
    })
    await store.flushPendingOrThrowAsync()
    await closeTestStores()
    const reopened = createStore()

    expect(desktopWindowUI(reopened.getUI(), first).lastActiveWorktreeId).toBe(GIT_KEY)
    expect(desktopWindowUI(reopened.getUI(), second).lastActiveWorktreeId).toBe(FOLDER_KEY)
    expect(desktopWindowUI(reopened.getUI(), first).uiZoomLevel).toBe(1)
    expect(desktopWindowUI(reopened.getUI(), second).windowBounds).toEqual({
      x: 80,
      y: 100,
      width: 1100,
      height: 800
    })
    expect(reopened.getUI().desktopWindows?.second?.open).toBe(false)
  })

  it('keeps UI selection, dimensions and zoom local while retaining shared preferences', () => {
    const { first, second, store } = fixture()
    updateDesktopWindowState(store, 'first', {
      bounds: { x: 20, y: 30, width: 1000, height: 700 },
      maximized: true
    })
    updateDesktopWindowUI(store, first, {
      lastActiveWorktreeId: GIT_KEY,
      activeView: 'settings',
      uiZoomLevel: 1,
      hideDefaultBranchWorkspace: true
    })
    updateDesktopWindowUI(store, second, {
      lastActiveWorktreeId: FOLDER_KEY,
      activeView: 'terminal',
      uiZoomLevel: -1
    })

    const a = desktopWindowUI(store.getUI(), first)
    const b = desktopWindowUI(store.getUI(), second)
    expect(a.lastActiveWorktreeId).toBe(GIT_KEY)
    expect(b.lastActiveWorktreeId).toBe(FOLDER_KEY)
    expect(a.activeView).toBe('settings')
    expect(b.activeView).toBe('terminal')
    expect(a.uiZoomLevel).toBe(1)
    expect(b.uiZoomLevel).toBe(-1)
    expect(a.windowBounds).toEqual({ x: 20, y: 30, width: 1000, height: 700 })
    expect(a.windowMaximized).toBe(true)
    expect(a.hideDefaultBranchWorkspace).toBe(true)
    expect(b.hideDefaultBranchWorkspace).toBe(true)
    expect(store.getUI().lastActiveWorktreeId).toBeNull()
  })

  it('restores each window view over the current common layout without reverting newer tabs', () => {
    const { first, second, store, session } = fixture()
    saveDesktopWindowSessionView(store, first, {
      ...session,
      activeWorktreeId: GIT_KEY,
      activeTabId: 'git-tab'
    })
    saveDesktopWindowSessionView(store, second, {
      ...session,
      activeWorktreeId: FOLDER_KEY,
      activeTabId: 'folder-tab'
    })
    session.tabsByWorktree[GIT_KEY]!.push({
      id: 'new-tab',
      ptyId: 'new-pty',
      worktreeId: GIT_KEY,
      title: 'New Terminal',
      createdAt: 10,
      generation: 0,
      customTitle: null,
      color: null,
      sortOrder: 1
    })

    const a = desktopWindowSession(store, first)
    const b = desktopWindowSession(store, second)
    expect(a.activeWorktreeId).toBe(GIT_KEY)
    expect(b.activeWorktreeId).toBe(FOLDER_KEY)
    expect(a.tabsByWorktree[GIT_KEY]?.map((tab) => tab.id)).toContain('new-tab')
    expect(b.tabsByWorktree[GIT_KEY]?.map((tab) => tab.id)).toContain('new-tab')
    expect(store.getWorkspaceSession()).toBe(session)
  })

  it('partitions a window view by execution host and keeps a closed window closed', () => {
    const { first, store, session } = fixture()
    saveDesktopWindowSessionView(store, first, { ...session, activeWorktreeId: GIT_KEY })
    saveDesktopWindowSessionView(
      store,
      first,
      { ...session, activeWorktreeId: SSH_KEY },
      'ssh:remote'
    )
    updateDesktopWindowState(store, 'first', { open: false })
    updateDesktopWindowUI(store, first, { uiZoomLevel: 2 })

    expect(desktopWindowSession(store, first).activeWorktreeId).toBe(GIT_KEY)
    expect(desktopWindowSession(store, first, 'ssh:remote').activeWorktreeId).toBe(SSH_KEY)
    expect(store.getUI().desktopWindows?.first?.open).toBe(false)
  })
})
