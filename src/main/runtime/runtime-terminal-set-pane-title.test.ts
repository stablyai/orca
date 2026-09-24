import './orca-runtime-test-lifecycle.spec'
import type { RuntimeStore } from './runtime-store-contract'
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService, electronMocks } from './orca-runtime-test-mocks.spec'
import {
  HEADLESS_LEAF_ID,
  TEST_WINDOW_ID,
  TEST_WORKTREE_ID,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal
} from './orca-runtime-test-fixtures.spec'

const SIBLING_LEAF_ID = '99999999-9999-4999-8999-999999999999'
const HOST_TAB_ID = 'host-tab'

function makeHeadlessPaneTitleRuntime() {
  const session = makeWorkspaceSessionWithHeadlessTerminal()
  session.terminalLayoutsByTabId[HOST_TAB_ID]!.titlesByLeafId = { [SIBLING_LEAF_ID]: 'Sibling' }
  const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(session)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The shared fixture supplies RuntimeStore methods; its legacy Mock return type loses callable signatures.
  const runtime = new OrcaRuntimeService(runtimeStore as RuntimeStore)
  const setPaneTitle = vi.fn()
  runtime.setPtyController({
    spawn: vi.fn(async () => ({ id: 'pane-title-pty' })),
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null
  })
  runtime.setNotifier({
    worktreesChanged: vi.fn(),
    reposChanged: vi.fn(),
    activateWorktree: vi.fn(),
    createTerminal: vi.fn(),
    splitTerminal: vi.fn(),
    renameTerminal: vi.fn(),
    focusTerminal: vi.fn(),
    closeTerminal: vi.fn(),
    sleepWorktree: vi.fn(),
    terminalFitOverrideChanged: vi.fn(),
    terminalDriverChanged: vi.fn(),
    setPaneTitle
  })
  // Headless: graph ready but no BrowserWindow backs the authoritative id, so getAvailableAuthoritativeWindow() is null.
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the electron mock's fromId is typed to return a BrowserWindow; the headless case it models has none, which is the whole point of the fixture.
  electronMocks.BrowserWindow.fromId.mockReturnValue(null as never)
  runtime.attachWindow(TEST_WINDOW_ID)
  runtime.markGraphReady(TEST_WINDOW_ID)
  return { runtime, getSession, setPaneTitle }
}

describe('terminal setPaneTitle', () => {
  it('trims, forwards, persists, and preserves sibling pane titles headlessly', async () => {
    const { runtime, getSession, setPaneTitle } = makeHeadlessPaneTitleRuntime()
    const created = await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      tabId: HOST_TAB_ID,
      leafId: HEADLESS_LEAF_ID
    })

    const receipt = await runtime.setPaneTitle(created.handle, '  REVIEWER  ')

    expect(setPaneTitle).toHaveBeenCalledWith(HOST_TAB_ID, HEADLESS_LEAF_ID, 'REVIEWER')
    expect(receipt).toEqual({
      handle: created.handle,
      tabId: HOST_TAB_ID,
      leafId: HEADLESS_LEAF_ID,
      title: 'REVIEWER'
    })
    expect(getSession().terminalLayoutsByTabId[HOST_TAB_ID]!.titlesByLeafId).toEqual({
      [SIBLING_LEAF_ID]: 'Sibling',
      [HEADLESS_LEAF_ID]: 'REVIEWER'
    })
  })

  it('treats a whitespace-only title as a clear that affects only the addressed leaf', async () => {
    const { runtime, getSession, setPaneTitle } = makeHeadlessPaneTitleRuntime()
    const created = await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      tabId: HOST_TAB_ID,
      leafId: HEADLESS_LEAF_ID
    })
    await runtime.setPaneTitle(created.handle, 'First')
    expect(getSession().terminalLayoutsByTabId[HOST_TAB_ID]!.titlesByLeafId).toEqual({
      [SIBLING_LEAF_ID]: 'Sibling',
      [HEADLESS_LEAF_ID]: 'First'
    })

    const receipt = await runtime.setPaneTitle(created.handle, '   ')

    expect(setPaneTitle).toHaveBeenLastCalledWith(HOST_TAB_ID, HEADLESS_LEAF_ID, null)
    expect(receipt.title).toBeNull()
    expect(getSession().terminalLayoutsByTabId[HOST_TAB_ID]!.titlesByLeafId).toEqual({
      [SIBLING_LEAF_ID]: 'Sibling'
    })
  })
})
