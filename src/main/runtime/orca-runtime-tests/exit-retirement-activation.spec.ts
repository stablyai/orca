import { withHeldSenderDiscovery } from '../runtime-agent-sender-snapshot.test-fixture'
import type { AdoptStablePaneArgs } from '../../ipc/pty/ipc/spawn-types'
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../orca-runtime-test-mocks.spec'
import {
  HEADLESS_LEAF_ID,
  HEADLESS_SECOND_LEAF_ID,
  TEST_WORKTREE_ID,
  makeDeferred,
  makeHeadlessTerminalLayout,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal
} from '../orca-runtime-test-fixtures.spec'

async function startSplitHost() {
  const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(
    makeWorkspaceSessionWithHeadlessTerminal({
      tabsByWorktree: {
        [TEST_WORKTREE_ID]: [
          {
            id: 'host-tab',
            ptyId: 'pty-a',
            worktreeId: TEST_WORKTREE_ID,
            title: 'Split Terminal',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      terminalLayoutsByTabId: {
        'host-tab': makeHeadlessTerminalLayout({
          [HEADLESS_LEAF_ID]: 'pty-a',
          [HEADLESS_SECOND_LEAF_ID]: 'pty-b'
        })
      }
    })
  )
  const spawn = vi.fn(async (options: { sessionId?: string }) => ({
    id: options.sessionId ?? 'fresh-pty'
  }))
  const adoptStablePane = vi.fn(async (args: AdoptStablePaneArgs) => {
    await args.spawnFresh?.({ mustExist: false })
    return null
  })
  const runtime = new OrcaRuntimeService(runtimeStore)
  runtime.setPtyController({
    spawn,
    adoptStablePane,
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    listProcesses: async () => []
  })
  runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
  const activate = (leafId: string, intent: 'user' | 'automatic') =>
    runtime.activateMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'host-tab', leafId, {
      notifyClients: false,
      navigation: 'caller',
      intent
    })
  const terminalLeafIds = async (): Promise<string[]> =>
    (await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)).tabs.flatMap((tab) =>
      tab.type === 'terminal' ? [tab.leafId] : []
    )
  await activate(HEADLESS_LEAF_ID, 'user')
  await activate(HEADLESS_SECOND_LEAF_ID, 'user')
  expect(spawn).toHaveBeenCalledTimes(2)
  expect(adoptStablePane).toHaveBeenCalledTimes(2)
  return { runtime, runtimeStore, getSession, spawn, adoptStablePane, activate, terminalLeafIds }
}

describe('OrcaRuntimeService', () => {
  // Paired stream-end reactivation can respawn exited leaves; retire before releasing the stream.
  it('retires an exited split leaf before its stream end, while the durable write is pending', async () => {
    const { runtime, runtimeStore, getSession, spawn, adoptStablePane, activate, terminalLeafIds } =
      await startSplitHost()

    await withHeldSenderDiscovery(runtime, async (release) => {
      const disk = makeDeferred()
      Object.assign(runtimeStore, { flushPendingOrThrowAsync: () => disk.promise })
      const published = vi.fn()
      const phone = vi.fn()
      runtime.onMobileSessionTabsChanged(published)
      runtime.onMobileSessionTabsChanged(phone, undefined, 'mobile')
      // Model immediate paired-client reactivation on stream end.
      let reactivation: Promise<unknown> | undefined
      let observedAtStreamEnd: { binding?: string; publications: number; phone: number } | undefined
      runtime.subscribeToPtyExit('pty-b', () => {
        observedAtStreamEnd = {
          binding:
            getSession().terminalLayoutsByTabId['host-tab']?.ptyIdsByLeafId?.[
              HEADLESS_SECOND_LEAF_ID
            ],
          publications: published.mock.calls.length,
          phone: phone.mock.calls.length
        }
        reactivation = activate(HEADLESS_SECOND_LEAF_ID, 'automatic').catch((error) => error)
      })
      const exiting = runtime.onPtyExit('pty-b', 0, undefined, { providerExitObserved: true })

      expect(observedAtStreamEnd).toEqual({ binding: undefined, publications: 1, phone: 1 })
      expect(reactivation).toBeDefined()
      // Lookup must reject before stable-pane adoption can revive the retired leaf.
      expect(await reactivation).toEqual(new Error('tab_not_found'))
      expect(adoptStablePane).toHaveBeenCalledTimes(2)
      expect(spawn).toHaveBeenCalledTimes(2)
      expect(phone.mock.calls[0]?.[0].agentSenderAssociations).toBeUndefined()
      await release()
      expect(await terminalLeafIds()).toEqual([HEADLESS_LEAF_ID])
      expect(
        getSession().terminalLayoutsByTabId['host-tab']?.ptyIdsByLeafId?.[HEADLESS_SECOND_LEAF_ID]
      ).toBeUndefined()

      disk.resolve()
      await exiting
      expect(await terminalLeafIds()).toEqual([HEADLESS_LEAF_ID])
    })
  })
})
