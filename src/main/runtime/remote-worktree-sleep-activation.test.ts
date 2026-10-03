import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from './orca-runtime-test-mocks.spec'
import './orca-runtime-test-lifecycle.spec'
import type { RuntimeClientEvent } from '../../shared/runtime-client-events'
import type { PtyProcessInfo } from '../providers/types'
import { makePaneKey } from '../../shared/stable-pane-id'
import { WORKTREE_TERMINAL_SLEEP_BLOCKED_ERROR } from './worktree-terminal-mutation-lock'
import {
  makeSleepActivationRuntime,
  makePartialSleepActivationRuntime
} from './remote-worktree-sleep-activation-test-fixture'
import {
  HEADLESS_LEAF_ID,
  HEADLESS_SECOND_LEAF_ID,
  TEST_WORKTREE_ID,
  TEST_WORKTREE_PATH,
  deferred
} from './orca-runtime-test-fixtures.spec'

function activate(runtime: OrcaRuntimeService, intent: 'automatic' | 'user') {
  return runtime.activateMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'host-tab', HEADLESS_LEAF_ID, {
    notifyClients: false,
    navigation: 'caller',
    intent
  })
}

function expectNoWake(events: RuntimeClientEvent[]) {
  expect(
    events.filter((event) => event.type === 'worktreeTerminalSleepState' && event.phase === 'woken')
  ).toEqual([])
}

describe('remote workspace sleep activation', () => {
  it('keeps a verified host sleep parked without an agent-resume record', async () => {
    const { runtime, spawn, events, getSession } = makeSleepActivationRuntime()
    expect(getSession().sleepingAgentSessionsByPaneKey ?? {}).toEqual({})
    await expect(
      runtime.sleepTerminalsForWorktree(`id:${TEST_WORKTREE_ID}`)
    ).resolves.toMatchObject({
      stopped: 1,
      postStopVerified: true
    })

    const result = await activate(runtime, 'automatic')

    expect(spawn).not.toHaveBeenCalled()
    expect(result.tabs[0]).toMatchObject({ status: 'pending-handle', terminal: null })
    expectNoWake(events)
    await runtime.activateMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'host-tab', HEADLESS_LEAF_ID, {
      notifyClients: false,
      navigation: 'caller',
      intent: 'automatic',
      clientNavigationId: 'reloaded-client'
    })
    expect(spawn).not.toHaveBeenCalled()
    await expect(
      runtime.sleepTerminalsForWorktree(`id:${TEST_WORKTREE_ID}`)
    ).resolves.toMatchObject({
      stopped: 0,
      postStopVerified: true
    })
  })

  it('refuses a recovery already queued behind sleep before the sleep state is published', async () => {
    const { runtime, controller, spawn, physicalSpawn, listProcesses, events } =
      makeSleepActivationRuntime(false)
    const adoption = deferred<null>()
    const adoptStablePane = vi.fn(() => adoption.promise)
    controller.adoptStablePane = adoptStablePane
    const recovery = activate(runtime, 'automatic')
    await vi.waitFor(() => expect(adoptStablePane).toHaveBeenCalledOnce())

    const inventory = deferred<Awaited<ReturnType<typeof listProcesses>>>()
    listProcesses.mockImplementationOnce(() => inventory.promise)
    const sleep = runtime.sleepTerminalsForWorktree(`id:${TEST_WORKTREE_ID}`)
    await vi.waitFor(() => expect(listProcesses).toHaveBeenCalledTimes(2))
    adoption.resolve(null)
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce())
    expect(physicalSpawn).not.toHaveBeenCalled()

    inventory.resolve([])
    await expect(sleep).resolves.toMatchObject({ postStopVerified: true })
    await expect(recovery).resolves.toMatchObject({
      tabs: [expect.objectContaining({ status: 'pending-handle', terminal: null })]
    })
    expect(physicalSpawn).not.toHaveBeenCalled()
    expectNoWake(events)

    await expect(activate(runtime, 'user')).resolves.toMatchObject({
      tabs: [expect.objectContaining({ status: 'ready' })]
    })
    expect(physicalSpawn).toHaveBeenCalledOnce()
  })

  it('does not ask a desktop renderer to focus a slept pane during automatic recovery', async () => {
    const { runtime, spawn } = makeSleepActivationRuntime()
    await runtime.sleepTerminalsForWorktree(`id:${TEST_WORKTREE_ID}`)
    const focusTerminal = vi.fn()
    const activateWorktree = vi.fn()
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree,
      createTerminal: vi.fn(),
      revealTerminalSession: vi.fn(),
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal,
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      resumeSleepingAgents: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })

    await runtime.activateMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'host-tab', HEADLESS_LEAF_ID, {
      navigation: 'all',
      intent: 'automatic'
    })

    expect(spawn).not.toHaveBeenCalled()
    expect(focusTerminal).not.toHaveBeenCalled()
    expect(activateWorktree).not.toHaveBeenCalled()
  })

  it('keeps committed panes parked when another terminal could not be stopped', async () => {
    const { runtime, controller, spawn, listProcesses, events } = makeSleepActivationRuntime()
    const stopAndWait = controller.stopAndWait
    controller.stopAndWait = async (ptyId) =>
      ptyId === 'unstopped-pty' ? false : ((await stopAndWait?.(ptyId)) ?? false)
    const failedPty: PtyProcessInfo = {
      id: 'unstopped-pty',
      cwd: TEST_WORKTREE_PATH,
      worktreeId: TEST_WORKTREE_ID,
      title: 'Other shell'
    }
    const processes = await listProcesses()
    listProcesses.mockResolvedValueOnce([...processes, failedPty]).mockResolvedValue([failedPty])

    await expect(runtime.sleepTerminalsForWorktree(`id:${TEST_WORKTREE_ID}`)).rejects.toThrow(
      'terminal_worktree_sleep_failed'
    )
    expect(runtime.getTerminalSleepClientEventSnapshot()).toContainEqual(
      expect.objectContaining({ phase: 'committed', ptyIds: ['persisted-pty'] })
    )
    const result = await activate(runtime, 'automatic')

    expect(spawn).not.toHaveBeenCalled()
    expect(result.tabs[0]).toMatchObject({ status: 'pending-handle', terminal: null })
    expectNoWake(events)
  })

  it.each([false, true])(
    'recovers an unstopped pane after partial Sleep (old capture: %s)',
    async (oldCapture) => {
      const { runtime, livePtys, physicalSpawn, events, getSession, setSession } =
        makePartialSleepActivationRuntime()
      if (oldCapture) {
        const paneKey = makePaneKey('unstopped-tab', HEADLESS_SECOND_LEAF_ID)
        setSession({
          ...getSession(),
          sleepingAgentSessionsByPaneKey: {
            [paneKey]: {
              paneKey,
              tabId: 'unstopped-tab',
              worktreeId: TEST_WORKTREE_ID,
              agent: 'claude',
              providerSession: { key: 'session_id', id: 'captured-session' },
              prompt: '',
              state: 'done',
              capturedAt: 1,
              updatedAt: 1,
              origin: 'worktree-sleep'
            }
          }
        })
      }
      await expect(runtime.sleepTerminalsForWorktree(`id:${TEST_WORKTREE_ID}`)).rejects.toThrow(
        'terminal_worktree_sleep_failed'
      )
      livePtys.delete('unstopped-pty')

      const result = await runtime.activateMobileSessionTab(
        `id:${TEST_WORKTREE_ID}`,
        'unstopped-tab',
        HEADLESS_SECOND_LEAF_ID,
        { notifyClients: false, navigation: 'caller', intent: 'automatic' }
      )

      expect(result.tabs).toContainEqual(
        expect.objectContaining({ parentTabId: 'unstopped-tab', status: 'ready' })
      )
      expect(physicalSpawn).toHaveBeenCalledOnce()
      expectNoWake(events)
      expect(runtime.getTerminalSleepClientEventSnapshot()).toContainEqual(
        expect.objectContaining({ phase: 'committed', ptyIds: ['persisted-pty'] })
      )
      await activate(runtime, 'automatic')
      expect(physicalSpawn).toHaveBeenCalledOnce()
      await activate(runtime, 'user')
      expect(physicalSpawn).toHaveBeenCalledTimes(2)
      expect(events).toContainEqual(expect.objectContaining({ phase: 'woken' }))
    }
  )

  it('refuses a partial-sleep spawn by the committed pane even without its old PTY id', async () => {
    const { runtime } = makePartialSleepActivationRuntime()
    await expect(runtime.sleepTerminalsForWorktree(`id:${TEST_WORKTREE_ID}`)).rejects.toThrow(
      'terminal_worktree_sleep_failed'
    )

    await expect(
      runtime.acquireWorktreeTerminalSpawn(TEST_WORKTREE_ID, 'automatic', {
        paneKey: makePaneKey('host-tab', HEADLESS_LEAF_ID)
      })
    ).rejects.toThrow(WORKTREE_TERMINAL_SLEEP_BLOCKED_ERROR)

    const release = await runtime.acquireWorktreeTerminalSpawn(TEST_WORKTREE_ID, 'automatic', {
      paneKey: makePaneKey('unstopped-tab', HEADLESS_SECOND_LEAF_ID)
    })
    release()
    expect(runtime.getTerminalSleepClientEventSnapshot()).toContainEqual(
      expect.objectContaining({ phase: 'committed', ptyIds: ['persisted-pty'] })
    )
  })

  it('protects a restored slept pane when its live record lacked a pane identity', async () => {
    const { runtime, livePtys } = makePartialSleepActivationRuntime(true)
    await expect(runtime.sleepTerminalsForWorktree(`id:${TEST_WORKTREE_ID}`)).rejects.toThrow(
      'terminal_worktree_sleep_failed'
    )
    expect(livePtys.has('persisted-pty')).toBe(false)

    await expect(
      runtime.acquireWorktreeTerminalSpawn(TEST_WORKTREE_ID, 'automatic', {
        ptyId: 'replacement-pty',
        paneKey: makePaneKey('host-tab', HEADLESS_LEAF_ID)
      })
    ).rejects.toThrow(WORKTREE_TERMINAL_SLEEP_BLOCKED_ERROR)
  })

  it('allows recovery after a failed sleep with no committed stops', async () => {
    const { runtime, physicalSpawn, listProcesses } = makeSleepActivationRuntime(false)
    listProcesses.mockRejectedValueOnce(new Error('host_unavailable'))
    await expect(runtime.sleepTerminalsForWorktree(`id:${TEST_WORKTREE_ID}`)).rejects.toThrow()

    const result = await activate(runtime, 'automatic')

    expect(physicalSpawn).toHaveBeenCalledOnce()
    expect(result.tabs[0]).toMatchObject({ status: 'ready' })
  })

  it.each(['user', undefined] as const)(
    'allows an explicit or legacy wake (%s)',
    async (intent) => {
      const { runtime, controller, physicalSpawn, events } = makeSleepActivationRuntime()
      await runtime.sleepTerminalsForWorktree(`id:${TEST_WORKTREE_ID}`)

      const result = await runtime.activateMobileSessionTab(
        `id:${TEST_WORKTREE_ID}`,
        'host-tab',
        HEADLESS_LEAF_ID,
        { notifyClients: false, navigation: 'caller', ...(intent ? { intent } : {}) }
      )

      expect(physicalSpawn).toHaveBeenCalledOnce()
      expect(result.tabs[0]).toMatchObject({ status: 'ready' })
      expect(events).toContainEqual(expect.objectContaining({ phase: 'woken' }))

      await controller.stopAndWait?.('persisted-pty')
      runtime.onPtyExit('persisted-pty', 0)
      const recovered = await activate(runtime, 'automatic')
      expect(physicalSpawn).toHaveBeenCalledTimes(2)
      expect(recovered.tabs[0]).toMatchObject({ status: 'ready' })
    }
  )

  it('still restores an exited terminal that was not deliberately slept', async () => {
    const { runtime, physicalSpawn } = makeSleepActivationRuntime(false)

    const result = await activate(runtime, 'automatic')

    expect(physicalSpawn).toHaveBeenCalledOnce()
    expect(result.tabs[0]).toMatchObject({ status: 'ready' })
  })
})
