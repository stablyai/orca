import './orca-runtime-test-lifecycle.spec'
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime-test-mocks.spec'
import {
  HEADLESS_LEAF_ID,
  TEST_WORKTREE_ID,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal
} from './orca-runtime-test-fixtures.spec'
import type { RuntimeNotifier } from './runtime-notifier-contract'

// After a restart, a reconnecting client restarts each saved tab's terminal. The mobile row for
// that tab must carry the tab's saved name, not only the new terminal's own title.
function notifier(): RuntimeNotifier {
  return {
    worktreesChanged() {},
    reposChanged() {},
    activateWorktree() {},
    createTerminal() {},
    splitTerminal() {},
    renameTerminal() {},
    focusTerminal() {},
    closeTerminal() {},
    terminalFitOverrideChanged() {},
    terminalDriverChanged() {}
  }
}

async function phoneSurface(runtime: OrcaRuntimeService) {
  const listed = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
  const surface = listed.tabs.find(
    (tab) => tab.type === 'terminal' && tab.parentTabId === 'host-tab'
  )
  return surface?.type === 'terminal' ? surface : undefined
}

function runtimeWithSession(savedName?: string | null): OrcaRuntimeService {
  const session = makeWorkspaceSessionWithHeadlessTerminal()
  if (savedName !== undefined) {
    session.tabsByWorktree[TEST_WORKTREE_ID]![0]!.customTitle = savedName
  }
  const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(session)
  return new OrcaRuntimeService(runtimeStore)
}

function controller(prefix: string) {
  let spawned = 0
  return {
    spawn: vi.fn(async () => ({ id: `${prefix}-${++spawned}` })),
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null
  }
}

describe('a saved tab name after its terminal is restarted', () => {
  it.each([
    ['with a notifier', true],
    ['headless', false]
  ])('reaches the phone %s', async (_label, withNotifier) => {
    const runtime = runtimeWithSession('Saved name')
    if (withNotifier) {
      runtime.setNotifier(notifier())
    }
    runtime.setPtyController(controller('respawned-pty'))

    await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'host-tab',
      leafId: HEADLESS_LEAF_ID,
      activate: true
    })

    expect(await phoneSurface(runtime)).toMatchObject({
      title: 'Saved name',
      customTitle: 'Saved name'
    })
  })

  it.each([
    ['no saved name', undefined],
    ['a cleared name', null]
  ])('leaves a tab with %s on its terminal title', async (_label, savedName) => {
    const runtime = runtimeWithSession(savedName)
    runtime.setNotifier(notifier())
    runtime.setPtyController(controller('respawned-pty'))

    await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'host-tab',
      leafId: HEADLESS_LEAF_ID,
      activate: true
    })

    const surface = await phoneSurface(runtime)
    expect(surface?.customTitle ?? null).toBeNull()
  })

  // The path a reconnecting client takes after a restart: the host restarts the saved tab's
  // terminal for the client by the tab's identity.
  it('reaches the phone when a client restarts the saved tab by its identity', async () => {
    const runtime = runtimeWithSession('Saved name')
    runtime.setNotifier(notifier())
    runtime.setPtyController(controller('client-restarted-pty'))

    await runtime['createRuntimeOwnedMobileSessionTerminal'](TEST_WORKTREE_ID, true, undefined, {
      identity: { tabId: 'host-tab', leafId: HEADLESS_LEAF_ID }
    })

    expect(await phoneSurface(runtime)).toMatchObject({
      title: 'Saved name',
      customTitle: 'Saved name'
    })
  })

  it('keeps a name cleared on the phone row cleared when the terminal restarts', async () => {
    const runtime = runtimeWithSession('Saved name')
    runtime.setNotifier(notifier())
    runtime.setPtyController(controller('client-restarted-pty'))
    const identity = { tabId: 'host-tab', leafId: HEADLESS_LEAF_ID }
    await runtime['createRuntimeOwnedMobileSessionTerminal'](TEST_WORKTREE_ID, true, undefined, {
      identity
    })
    // A desktop clear reaches the row before its debounced session write drops the old name.
    const snapshot = runtime['mobileSessionTabsByWorktree'].get(TEST_WORKTREE_ID)!
    runtime['mobileSessionTabsByWorktree'].set(TEST_WORKTREE_ID, {
      ...snapshot,
      tabs: snapshot.tabs.map((tab) =>
        tab.type === 'terminal' && tab.parentTabId === 'host-tab'
          ? { ...tab, customTitle: null }
          : tab
      )
    })

    await runtime['createRuntimeOwnedMobileSessionTerminal'](TEST_WORKTREE_ID, true, undefined, {
      identity
    })

    expect((await phoneSurface(runtime))?.customTitle).toBeNull()
  })
})
