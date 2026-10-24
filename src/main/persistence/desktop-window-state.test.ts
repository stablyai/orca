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
import { closeTestStores, createStore, testState } from '../persistence-test-harness'
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

let databaseDirectory: string | null = null

afterEach(async () => {
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
