import { expect, it, vi } from 'vitest'
import { fixture } from '../persistence/loading-store/profile-state-delayed-authority-fixture'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../shared/layout-owner-switch'
import { ClientSessionTabSelectionStore } from './client-session-tab-selection'
import { TerminalCloseRuntime } from './__fixtures__/terminal-close-runtime.test-fixture'
import { createCloseContinuityGraphFixture } from './__fixtures__/orca-runtime-terminal-close-continuity-graph-fixture'
import {
  INCARNATION_ID,
  LEAF_ID,
  PTY_ID,
  REPO_ID,
  TAB_ID,
  WORKTREE_ID,
  WORKTREE_PATH,
  makeSession
} from './__fixtures__/orca-runtime-terminal-close-continuity-state-fixture'

it('retires the authenticated final pane through the real Store and forgets its tab selection', async () => {
  const { store, readState } = await fixture()
  store.addRepo({
    id: REPO_ID,
    path: WORKTREE_PATH,
    displayName: 'Original retirement',
    badgeColor: '#000000',
    addedAt: 1
  })
  store.setWorkspaceSession(makeSession())
  await store.flushPendingOrThrowAsync()
  const runtime = new TerminalCloseRuntime(store)
  const kill = vi.fn(() => true)
  const closeTerminalTab = vi.fn(async () => {})
  runtime.setNotifier({
    worktreesChanged: vi.fn(),
    reposChanged: vi.fn(),
    activateWorktree: vi.fn(),
    createTerminal: vi.fn(),
    splitTerminal: vi.fn(),
    renameTerminal: vi.fn(),
    focusTerminal: vi.fn(),
    closeTerminal: vi.fn(),
    terminalFitOverrideChanged: vi.fn(),
    terminalDriverChanged: vi.fn(),
    closeTerminalTab
  })
  const stopAndWait = vi.fn(async () => {
    await runtime.onPtyExit(PTY_ID, 0, INCARNATION_ID, { hostExitConfirmed: true })
    expect(store.getWorkspaceSession().terminalLayoutsByTabId[TAB_ID]).toBeDefined()
    return true
  })
  runtime.setPtyController({
    write: () => true,
    kill,
    stopAndWait,
    getForegroundProcess: async () => null
  })
  runtime.attachWindow(1)
  runtime.registerPty(PTY_ID, WORKTREE_ID, null, {
    tabId: TAB_ID,
    leafId: LEAF_ID,
    incarnationId: INCARNATION_ID
  })
  createCloseContinuityGraphFixture({
    runtime,
    ptyId: PTY_ID,
    publishMobileSurface: true,
    getSession: () => store.getWorkspaceSession(),
    setSession: (session) => store.setWorkspaceSession(session),
    markSiblingPtyIncluded: () => {}
  }).syncFixtureGraph()
  const command = {
    type: 'closePane',
    workspace: WORKTREE_ID,
    tabId: TAB_ID,
    leafId: LEAF_ID
  } as const
  await expect(runtime.applyLayoutCommand(command)).resolves.toMatchObject({
    ok: false,
    code: 'last_pane'
  })
  const source = runtime.resolveTerminalPane(`${TAB_ID}:${LEAF_ID}`, WORKTREE_ID)
  expect(source.presentation).toBeDefined()
  expect(source.incarnationId).toBe(INCARNATION_ID)
  if (!source.presentation || !source.incarnationId) {
    throw new Error('Missing authenticated original')
  }
  const apply = vi.spyOn(store, 'applyLayoutCommand')
  const forget = vi.spyOn(ClientSessionTabSelectionStore.prototype, 'forgetTabs')
  await expect(
    runtime.closeTerminal(source.handle, source.incarnationId, source.presentation)
  ).resolves.toMatchObject({ ptyKilled: true })
  if (ORCA_LAYOUT_OWNER_IS_MAIN) {
    expect(apply).toHaveResolvedWith({ ok: true, result: { closed: [TAB_ID] } })
  }
  expect(forget).toHaveBeenCalledWith(WORKTREE_ID, [TAB_ID])
  expect(stopAndWait).toHaveBeenCalledExactlyOnceWith(
    PTY_ID,
    expect.objectContaining({ expectedIncarnationId: INCARNATION_ID })
  )
  expect(kill).not.toHaveBeenCalled()
  expect(closeTerminalTab).toHaveBeenCalledExactlyOnceWith(TAB_ID, {
    localPtyTeardownOwnedExternally: true,
    originalSurface: source.presentation.identity
  })
  expect(store.getWorkspaceSession().tabsByWorktree[WORKTREE_ID]).toEqual([])
  expect(readState().workspaceSession.tabsByWorktree[WORKTREE_ID]).toEqual([])
  expect(store.getWorkspaceSession().closedTerminalTabTombstonesByTabId?.[TAB_ID]).toBeDefined()
})
