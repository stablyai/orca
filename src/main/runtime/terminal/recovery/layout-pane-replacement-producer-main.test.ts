import { expect, it, vi } from 'vitest'
import {
  RetainedTerminalStartError,
  type RetainedTerminalStart
} from '../../../../shared/workspace-layout/retained-terminal-start'
import {
  makePaneSpawnReservationKey,
  reserveIdlePaneSpawn,
  rejectPaneSpawnReservation
} from '../../../ipc/pty/pane/spawn-reservation'

vi.mock('../../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

// Preserve the runtime fixture's mock registration and lifecycle order.
await import('../../orca-runtime-tests/runtime-test-module-registration.spec')
await import('../../orca-runtime-tests/orca-runtime-test-lifecycle.spec')
const { HEADLESS_LEAF_ID, TEST_WORKTREE_ID, TEST_WORKTREE_PATH } =
  await import('../../orca-runtime-tests/orca-runtime-test-fixtures.spec')
const { layoutPaneReplacementController } =
  await import('./layout-pane-replacement-controller.test-fixture')

it('commits a main-layout replacement through the real controller and releases a queued exclusive workspace action', async () => {
  const fixture = layoutPaneReplacementController()
  const { runtime, spawned, spawn, getSession } = fixture
  const paneKey = `host-tab:${HEADLESS_LEAF_ID}`
  runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
  runtime.registerPty('persisted-pty', TEST_WORKTREE_ID, null, {
    tabId: 'host-tab',
    leafId: HEADLESS_LEAF_ID,
    incarnationId: 'incarnation-old'
  })
  try {
    const restart = runtime.applyLayoutCommand({
      type: 'restartPane',
      workspace: TEST_WORKTREE_ID,
      tabId: 'host-tab',
      paneKey
    })
    await Promise.race([runtime.admitted.promise, restart])

    let exclusiveCompleted = false
    const exclusive = runtime.exclusiveWorkspaceAction(async () => {
      // A following owner must also be able to reserve this pane after replacement commits.
      const key = makePaneSpawnReservationKey(TEST_WORKTREE_ID, null, paneKey)!
      const reservation = await reserveIdlePaneSpawn(key)
      rejectPaneSpawnReservation(key, reservation, new Error('following owner released'))
      exclusiveCompleted = true
      return getSession().terminalLayoutsByTabId['host-tab']?.ptyIdsByLeafId?.[HEADLESS_LEAF_ID]
    })
    await Promise.resolve()
    expect(exclusiveCompleted).toBe(false)
    runtime.continueAdmission.resolve()
    await expect(restart).resolves.toMatchObject({ ok: true })
    const started = runtime.ensureRestoredPaneStarted({
      worktreeId: TEST_WORKTREE_ID,
      tabId: 'host-tab',
      leafId: HEADLESS_LEAF_ID
    })
    await Promise.race([fixture.dispatched, started])
    spawned.resolve({ id: 'replacement-pty', incarnationId: 'incarnation-new' })

    await expect(started).resolves.toMatchObject({ id: 'replacement-pty' })
    await expect(exclusive).resolves.toBe('replacement-pty')
    expect(getSession().tabsByWorktree[TEST_WORKTREE_ID]?.[0]?.ptyId).toBe('replacement-pty')
    expect(getSession().terminalPtyIncarnationsByPaneKey?.[paneKey]).toBe('incarnation-new')
    expect(
      fixture.durableSessions.at(-1)?.terminalLayoutsByTabId['host-tab']?.ptyIdsByLeafId?.[
        HEADLESS_LEAF_ID
      ]
    ).toBe('replacement-pty')
    expect(fixture.durableSessions.at(-1)?.terminalPtyIncarnationsByPaneKey?.[paneKey]).toBe(
      'incarnation-new'
    )
    expect(fixture.shutdown).toHaveBeenCalledWith('persisted-pty', expect.any(Object))
    expect(spawn).toHaveBeenCalledOnce()
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: TEST_WORKTREE_PATH,
        shellOverride: process.platform === 'win32' ? 'powershell.exe' : '/bin/zsh'
      })
    )
  } finally {
    runtime.continueAdmission.resolve()
    spawned.resolve({ id: 'replacement-pty', incarnationId: 'incarnation-new' })
    fixture.restoreProvider()
  }
})

it('keeps the prepared retained attempt through main starting, materialization and real controller failure before a later replacement binds', async () => {
  const fixture = layoutPaneReplacementController()
  const { runtime, spawn, getSession } = fixture
  const tabId = 'retained-main-tab'
  const leafId = '88888888-8888-4888-8888-888888888888'
  const restart = {
    type: 'restartPane' as const,
    workspace: TEST_WORKTREE_ID,
    tabId,
    paneKey: `${tabId}:${leafId}`
  }
  runtime.continueAdmission.resolve()
  runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
  const observed: {
    preparedStart: RetainedTerminalStart | null
    failBeforeCreate: boolean
    started?: ReturnType<typeof runtime.ensureRestoredPaneStarted>
  } = {
    preparedStart: null,
    failBeforeCreate: false
  }
  const resolveWorkspace = vi.spyOn(runtime, 'resolveTerminalWorkspaceLaunchScope')
  let finishProvider: (() => void) | undefined
  const ensure = runtime.ensureRestoredPaneStarted.bind(runtime)
  const starting = vi
    .spyOn(runtime, 'ensureRestoredPaneStarted')
    .mockImplementation((target, trigger) => {
      if (trigger?.preparedReplacement) {
        observed.preparedStart = runtime.getRetainedTerminalStart(
          target.worktreeId,
          target.tabId,
          target.leafId
        )
        if (observed.failBeforeCreate) {
          observed.failBeforeCreate = false
          resolveWorkspace.mockRejectedValueOnce(
            new Error('The restored workspace is unavailable.')
          )
        }
      }
      const started = ensure(target, trigger)
      if (trigger?.preparedReplacement) {
        observed.started = started
      }
      return started
    })
  try {
    spawn.mockRejectedValueOnce(
      Object.assign(new Error('The initial main provider outcome is unknown.'), {
        agentSessionOperationOutcome: 'unknown'
      })
    )
    await expect(
      runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
        tabId,
        leafId,
        keepPaneOnStartFailure: true,
        presentation: 'background'
      })
    ).rejects.toThrow('The initial main provider outcome is unknown.')
    expect(runtime.getRetainedTerminalStart(TEST_WORKTREE_ID, tabId, leafId)?.status).toBe(
      'starting'
    )
    const savedLayout = structuredClone(getSession().terminalLayoutsByTabId[tabId])
    observed.failBeforeCreate = true
    await expect(runtime.applyLayoutCommand(restart)).resolves.toMatchObject({ ok: true })
    await expect(observed.started).rejects.toBeInstanceOf(RetainedTerminalStartError)
    expect(runtime.getRetainedTerminalStartupDestinations()).toMatchObject([
      {
        start: {
          tabId,
          leafId,
          startSequence: observed.preparedStart?.startSequence,
          status: 'failed',
          reason: 'The restored workspace is unavailable.'
        },
        layout: savedLayout
      }
    ])
    expect(spawn).toHaveBeenCalledOnce()
    const dispatched = Promise.withResolvers<void>()
    const rejected = Promise.withResolvers<never>()
    spawn.mockImplementationOnce(() => {
      finishProvider = () => rejected.reject(new Error('test provider cleanup'))
      dispatched.resolve()
      return rejected.promise
    })
    await expect(runtime.applyLayoutCommand(restart)).resolves.toMatchObject({ ok: true })
    const started = observed.started!.catch((error: unknown) => error)
    await Promise.race([dispatched.promise, started])
    expect(observed.preparedStart).toMatchObject({ tabId, leafId, status: 'starting' })
    expect(runtime.getRetainedTerminalStart(TEST_WORKTREE_ID, tabId, leafId)).toBe(
      observed.preparedStart
    )
    rejected.reject(new Error('The main replacement shell could not start.'))
    expect(await started).toBeInstanceOf(RetainedTerminalStartError)
    expect(runtime.getRetainedTerminalStartupDestinations()).toMatchObject([
      {
        start: {
          tabId,
          leafId,
          startSequence: observed.preparedStart?.startSequence,
          status: 'failed',
          reason: 'The main replacement shell could not start.'
        },
        layout: savedLayout
      }
    ])
    await expect(
      runtime.exclusiveWorkspaceAction(async () => 'after failed replacement')
    ).resolves.toBe('after failed replacement')
    const accepted = Promise.withResolvers<void>()
    const provider = Promise.withResolvers<{ id: string; incarnationId: string }>()
    spawn.mockImplementationOnce(() => {
      finishProvider = () =>
        provider.resolve({ id: 'replacement-pty', incarnationId: 'main-recovery-incarnation' })
      accepted.resolve()
      return provider.promise
    })
    await expect(runtime.applyLayoutCommand(restart)).resolves.toMatchObject({ ok: true })
    const recovered = observed.started!
    await Promise.race([accepted.promise, recovered])
    provider.resolve({ id: 'replacement-pty', incarnationId: 'main-recovery-incarnation' })
    await expect(recovered).resolves.toMatchObject({ id: 'replacement-pty' })
    expect(runtime.getRetainedTerminalStartupDestinations()).toEqual([])
    expect(getSession().terminalLayoutsByTabId[tabId]?.ptyIdsByLeafId?.[leafId]).toBe(
      'replacement-pty'
    )
    expect(getSession().terminalPtyIncarnationsByPaneKey?.[`${tabId}:${leafId}`]).toBe(
      'main-recovery-incarnation'
    )
    expect(spawn).toHaveBeenCalledTimes(3)
    expect(fixture.shutdown).not.toHaveBeenCalled()
  } finally {
    finishProvider?.()
    await observed.started?.catch(() => {})
    starting.mockRestore()
    resolveWorkspace.mockRestore()
    fixture.restoreProvider()
  }
})
