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
  const adoptStablePane = vi.fn(async () => null)
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
  // Why: a paired mirror answers an exit's stream end by re-activating its pane. An activation
  // that still finds the leaf respawns the exited session, and the retirement never publishes.
  it('retires an exited split leaf before its stream end, while the durable write is pending', async () => {
    const { runtime, runtimeStore, getSession, spawn, adoptStablePane, activate, terminalLeafIds } =
      await startSplitHost()

    const disk = makeDeferred()
    Object.assign(runtimeStore, { flushPendingOrThrowAsync: () => disk.promise })
    const published = vi.fn()
    runtime.onMobileSessionTabsChanged(published)
    // The stream end: the mirror's re-activation starts the moment the host releases it.
    let reactivation: Promise<unknown> | undefined
    let observedAtStreamEnd: { binding?: string; publications: number } | undefined
    runtime.subscribeToPtyExit('pty-b', () => {
      observedAtStreamEnd = {
        binding:
          getSession().terminalLayoutsByTabId['host-tab']?.ptyIdsByLeafId?.[
            HEADLESS_SECOND_LEAF_ID
          ],
        publications: published.mock.calls.length
      }
      reactivation = activate(HEADLESS_SECOND_LEAF_ID, 'automatic').catch((error) => error)
    })
    const exiting = runtime.onPtyExit('pty-b', 0, undefined, { providerExitObserved: true })

    // Why: whatever answers the stream end, over any transport, must already see the leaf retired.
    expect(observedAtStreamEnd).toEqual({ binding: undefined, publications: 1 })
    expect(reactivation).toBeDefined()
    // Why: the refusal must come from the lookup, before any stable-pane adoption can revive it.
    expect(await reactivation).toEqual(new Error('tab_not_found'))
    expect(adoptStablePane).toHaveBeenCalledTimes(2)
    expect(spawn).toHaveBeenCalledTimes(2)
    expect(await terminalLeafIds()).toEqual([HEADLESS_LEAF_ID])
    expect(
      getSession().terminalLayoutsByTabId['host-tab']?.ptyIdsByLeafId?.[HEADLESS_SECOND_LEAF_ID]
    ).toBeUndefined()

    disk.resolve()
    await exiting
    expect(await terminalLeafIds()).toEqual([HEADLESS_LEAF_ID])
  })

  // Why: the process is gone whether or not the profile admits the write (quit, maintenance).
  it('retires the pane and ends the stream when the profile refuses the staging write', async () => {
    const { runtime, runtimeStore, activate, terminalLeafIds } = await startSplitHost()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    runtimeStore.setWorkspaceSession.mockImplementation(() => {
      throw new Error('Profile maintenance or finalization is blocking new terminal snapshot work')
    })
    const streamEnd = vi.fn()
    runtime.subscribeToPtyExit('pty-b', streamEnd)

    await runtime.onPtyExit('pty-b', 0, undefined, { providerExitObserved: true })

    expect(streamEnd).toHaveBeenCalledOnce()
    expect(await terminalLeafIds()).toEqual([HEADLESS_LEAF_ID])
    await expect(activate(HEADLESS_SECOND_LEAF_ID, 'automatic')).rejects.toThrow('tab_not_found')
    expect(errorSpy).toHaveBeenCalledWith(
      '[runtime] could not stage terminal retirement:',
      expect.any(Error)
    )
    errorSpy.mockRestore()
  })

  // Why: the stream end now waits behind the exit cleanup; a cleanup fault must not strand it.
  it('still ends the stream when exit cleanup throws before the retirement', () => {
    const runtime = new OrcaRuntimeService()
    Object.assign(runtime, {
      disposeHeadlessTerminal: () => {
        throw new Error('dispose_failed')
      }
    })
    const streamEnd = vi.fn()
    runtime.subscribeToPtyExit('pty-a', streamEnd)

    expect(() => runtime.onPtyExit('pty-a', 0)).toThrow('dispose_failed')
    expect(streamEnd).toHaveBeenCalledOnce()
  })
})
