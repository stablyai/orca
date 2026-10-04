import { vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime-test-mocks.spec'
import type { RuntimeClientEvent } from '../../shared/runtime-client-events'
import type { PtyProcessInfo } from '../providers/types'
import type { RuntimePtyController } from './runtime-pty-controller-contract'
import { makePaneKey } from '../../shared/stable-pane-id'
import {
  HEADLESS_LEAF_ID,
  HEADLESS_SECOND_LEAF_ID,
  TEST_WORKTREE_ID,
  TEST_WORKTREE_PATH,
  makeHeadlessTerminalLayout,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal
} from './orca-runtime-test-fixtures.spec'

export function makeSleepActivationRuntime(initiallyLive = true, registerSurface = true) {
  const { runtimeStore, getSession, setSession } = makeRuntimeStoreWithWorkspaceSession(
    makeWorkspaceSessionWithHeadlessTerminal()
  )
  const runtime = new OrcaRuntimeService(runtimeStore)
  const livePtys = new Map<string, PtyProcessInfo>()
  const processFor = (id: string): PtyProcessInfo => ({
    id,
    cwd: TEST_WORKTREE_PATH,
    worktreeId: TEST_WORKTREE_ID,
    title: 'Shell'
  })
  if (initiallyLive) {
    livePtys.set('persisted-pty', processFor('persisted-pty'))
  }
  const events: RuntimeClientEvent[] = []
  runtime.onClientEvent((event) => events.push(event))
  const physicalSpawn = vi.fn(async (sessionId?: string) => {
    const id = sessionId ?? 'persisted-pty'
    livePtys.set(id, processFor(id))
    return { id }
  })
  const spawn = vi.fn<NonNullable<RuntimePtyController['spawn']>>(async (opts) => {
    const release = await runtime.acquireWorktreeTerminalSpawn(
      opts.worktreeId,
      opts.activationIntent,
      {
        ptyId: opts.sessionId,
        paneKey: opts.tabId && opts.leafId ? makePaneKey(opts.tabId, opts.leafId) : undefined
      }
    )
    try {
      return await physicalSpawn(opts.sessionId)
    } finally {
      release()
    }
  })
  const listProcesses = vi.fn<NonNullable<RuntimePtyController['listProcesses']>>(async () => [
    ...livePtys.values()
  ])
  const controller: RuntimePtyController = {
    spawn,
    write: () => true,
    kill: () => false,
    stopAndWait: async (ptyId) => livePtys.delete(ptyId),
    getForegroundProcess: async () => null,
    listProcesses
  }
  runtime.setPtyController(controller)
  runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
  if (initiallyLive && registerSurface) {
    runtime.registerPty('persisted-pty', TEST_WORKTREE_ID, null, {
      tabId: 'host-tab',
      leafId: HEADLESS_LEAF_ID
    })
  }
  return {
    runtime,
    controller,
    spawn,
    physicalSpawn,
    listProcesses,
    livePtys,
    events,
    getSession,
    setSession
  }
}

export function makePartialSleepActivationRuntime(restoredWithoutPaneIdentity = false) {
  const fixture = makeSleepActivationRuntime(true, !restoredWithoutPaneIdentity)
  const session = fixture.getSession()
  const firstTab = session.tabsByWorktree[TEST_WORKTREE_ID]?.[0]
  if (!firstTab) {
    throw new Error('Missing fixture terminal tab')
  }
  fixture.setSession({
    ...session,
    tabsByWorktree: {
      ...session.tabsByWorktree,
      [TEST_WORKTREE_ID]: [firstTab, { ...firstTab, id: 'unstopped-tab', ptyId: 'unstopped-pty' }]
    },
    terminalLayoutsByTabId: {
      ...session.terminalLayoutsByTabId,
      'unstopped-tab': makeHeadlessTerminalLayout({ [HEADLESS_SECOND_LEAF_ID]: 'unstopped-pty' })
    }
  })
  fixture.livePtys.set('unstopped-pty', {
    id: 'unstopped-pty',
    cwd: TEST_WORKTREE_PATH,
    worktreeId: TEST_WORKTREE_ID,
    title: 'Other shell'
  })
  fixture.runtime.registerPty('unstopped-pty', TEST_WORKTREE_ID, null, {
    tabId: 'unstopped-tab',
    leafId: HEADLESS_SECOND_LEAF_ID
  })
  fixture.controller.stopAndWait = async (ptyId) =>
    ptyId !== 'unstopped-pty' && fixture.livePtys.delete(ptyId)
  return fixture
}
