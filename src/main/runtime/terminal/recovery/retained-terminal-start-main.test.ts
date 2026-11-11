import { expect, it, vi } from 'vitest'
import * as fsPromises from 'node:fs/promises'
import { RetainedTerminalStartError } from '../../../../shared/workspace-layout/retained-terminal-start'
import { getDefaultSettings } from '../../../../shared/constants'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fsPromises>()
  return { ...actual, mkdir: vi.fn(actual.mkdir) }
})

vi.mock('../../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: false }))
await import('../../orca-runtime-tests/runtime-test-module-registration.spec')
await import('../../orca-runtime-tests/orca-runtime-test-lifecycle.spec')
const { TEST_WORKTREE_ID } =
  await import('../../orca-runtime-tests/orca-runtime-test-fixtures.spec')
const { layoutPaneReplacementController } =
  await import('./layout-pane-replacement-controller.test-fixture')

it('keeps a real admitted provider failure available through prepare and passive activation until explicit recovery binds', async () => {
  const fixture = layoutPaneReplacementController()
  const { runtime, spawn, getSession } = fixture
  const tabId = 'retained-tab'
  const leafId = '22222222-2222-4222-8222-222222222222'
  runtime.continueAdmission.resolve()
  runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
  const create = () =>
    runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      tabId,
      leafId,
      keepPaneOnStartFailure: true,
      presentation: 'background'
    })
  try {
    spawn.mockRejectedValueOnce(new Error('The selected shell could not start.'))
    const error = await create().catch((failure: unknown) => failure)
    expect(error).toBeInstanceOf(RetainedTerminalStartError)
    expect(getSession().tabsByWorktree[TEST_WORKTREE_ID]?.some((tab) => tab.id === tabId)).toBe(
      true
    )
    const initial = runtime.getRetainedTerminalStartupDestinations()
    expect(initial).toEqual([
      expect.objectContaining({
        start: expect.objectContaining({
          tabId,
          leafId,
          status: 'failed',
          reason: 'The selected shell could not start.'
        })
      })
    ])
    const before = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    const activated = await runtime.activateMobileSessionTab(
      `id:${TEST_WORKTREE_ID}`,
      tabId,
      leafId,
      {
        preserveRetainedStart: true,
        intent: 'user',
        navigation: 'caller'
      }
    )
    expect(
      activated.tabs.find((tab) => tab.type === 'terminal' && tab.parentTabId === tabId)
    ).toMatchObject({
      status: 'pending-handle',
      terminal: null,
      retainedTerminalStart: { status: 'failed' }
    })
    expect(spawn).toHaveBeenCalledOnce()
    spawn.mockResolvedValueOnce({ id: 'replacement-pty', incarnationId: 'fresh-incarnation' })
    await expect(create()).resolves.toMatchObject({ ptyId: 'replacement-pty' })
    const after = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    expect(after.snapshotVersion).toBeGreaterThan(before.snapshotVersion)
    expect(runtime.getRetainedTerminalStartupDestinations()).toEqual([])
    expect(getSession().terminalLayoutsByTabId[tabId]?.ptyIdsByLeafId?.[leafId]).toBe(
      'replacement-pty'
    )
  } finally {
    fixture.restoreProvider()
  }
})

it('does not create a window destination when the prepared controller is unavailable', async () => {
  const fixture = layoutPaneReplacementController()
  fixture.runtime.continueAdmission.resolve()
  fixture.runtime.setPtyController(null)
  try {
    const create = fixture.runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'preadmission-tab',
      leafId: '33333333-3333-4333-8333-333333333333',
      keepPaneOnStartFailure: true,
      presentation: 'background'
    })
    await expect(create).rejects.toThrow()
    expect(fixture.spawn).not.toHaveBeenCalled()
    expect(
      fixture
        .getSession()
        .tabsByWorktree[TEST_WORKTREE_ID]?.some((tab) => tab.id === 'preadmission-tab')
    ).toBe(false)
    expect(fixture.runtime.getRetainedTerminalStartupDestinations()).toEqual([])
  } finally {
    fixture.restoreProvider()
  }
})

it('keeps an unknown provider result qualified without converting it to failure or repeating dispatch', async () => {
  const fixture = layoutPaneReplacementController()
  const { runtime, spawn, getSession } = fixture
  runtime.continueAdmission.resolve()
  runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
  try {
    spawn.mockRejectedValueOnce(
      Object.assign(new Error('Could not confirm the terminal started.'), {
        agentSessionOperationOutcome: 'unknown'
      })
    )
    await expect(
      runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
        tabId: 'unknown-tab',
        leafId: '44444444-4444-4444-8444-444444444444',
        keepPaneOnStartFailure: true,
        presentation: 'background'
      })
    ).rejects.toThrow('Could not confirm')
    expect(runtime.getRetainedTerminalStartupDestinations()).toMatchObject([
      { start: { tabId: 'unknown-tab', status: 'starting' } }
    ])
    const row = await runtime.activateMobileSessionTab(
      `id:${TEST_WORKTREE_ID}`,
      'unknown-tab',
      '44444444-4444-4444-8444-444444444444',
      {
        preserveRetainedStart: true,
        intent: 'user',
        navigation: 'caller'
      }
    )
    expect(
      row.tabs.find((tab) => tab.type === 'terminal' && tab.parentTabId === 'unknown-tab')
    ).toMatchObject({
      terminal: null,
      retainedTerminalStart: { status: 'starting' }
    })
    expect(getSession().terminalLayoutsByTabId['unknown-tab']?.ptyIdsByLeafId).toEqual({})
    expect(spawn).toHaveBeenCalledOnce()
    spawn.mockRejectedValueOnce(new Error('The selected shell could not start on Restart.'))
    const retry = await runtime
      .startExistingPane({
        worktreeId: TEST_WORKTREE_ID,
        tabId: 'unknown-tab',
        leafId: '44444444-4444-4444-8444-444444444444',
        cols: 80,
        rows: 24,
        persistHostSessionBinding: true
      })
      .catch((error: unknown) => error)
    expect(retry).toBeInstanceOf(RetainedTerminalStartError)
    expect(runtime.getRetainedTerminalStartupDestinations()).toMatchObject([
      {
        start: {
          tabId: 'unknown-tab',
          status: 'failed',
          reason: 'The selected shell could not start on Restart.'
        }
      }
    ])
    const target = {
      worktreeId: TEST_WORKTREE_ID,
      tabId: 'unknown-tab',
      leafId: '44444444-4444-4444-8444-444444444444',
      cols: 80,
      rows: 24,
      persistHostSessionBinding: true
    }
    const dispatch = Promise.withResolvers<void>()
    const uncertain = Promise.withResolvers<never>()
    spawn.mockImplementationOnce(() => {
      dispatch.resolve()
      return uncertain.promise
    })
    const recovering = runtime.startExistingPane(target).catch((error: unknown) => error)
    await dispatch.promise
    const joining = Promise.withResolvers<void>()
    const adopt = fixture.adopt.getMockImplementation()!
    fixture.adopt.mockImplementationOnce((args) => {
      joining.resolve()
      return adopt(args)
    })
    const joined = runtime.startExistingPane(target).catch((error: unknown) => error)
    await joining.promise
    const uncertainFailure = Object.assign(new Error('The replacement outcome is unknown.'), {
      agentSessionOperationOutcome: 'unknown'
    })
    uncertain.reject(uncertainFailure)
    expect(await recovering).toBe(uncertainFailure)
    expect(await joined).toBe(uncertainFailure)
    expect(spawn).toHaveBeenCalledTimes(3)
    expect(runtime.getRetainedTerminalStartupDestinations()).toMatchObject([
      { start: { tabId: 'unknown-tab', status: 'starting' } }
    ])
    const policy = vi
      .spyOn(runtime, 'acquireWorktreeTerminalSpawn')
      .mockRejectedValueOnce(new Error('The workspace refused this Restart.'))
    try {
      const refused = await runtime.startExistingPane(target).catch((error: unknown) => error)
      expect(refused).toBeInstanceOf(RetainedTerminalStartError)
      expect(runtime.getRetainedTerminalStartupDestinations()).toMatchObject([
        { start: { status: 'failed', reason: 'The workspace refused this Restart.' } }
      ])
      expect(spawn).toHaveBeenCalledTimes(3)
    } finally {
      policy.mockRestore()
    }
    spawn.mockResolvedValueOnce({ id: 'replacement-pty', incarnationId: 'fresh-incarnation' })
    await expect(runtime.startExistingPane(target)).resolves.toMatchObject({
      id: 'replacement-pty'
    })
    expect(runtime.getRetainedTerminalStartupDestinations()).toEqual([])
    expect(
      getSession().terminalLayoutsByTabId['unknown-tab']?.ptyIdsByLeafId?.[target.leafId]
    ).toBe('replacement-pty')
  } finally {
    fixture.restoreProvider()
  }
})

it.skipIf(process.platform === 'win32')(
  'publishes a definite team-preparation failure on an ended unknown before the shared controller runs',
  async () => {
    const fixture = layoutPaneReplacementController()
    const { runtime, runtimeStore, spawn, getSession } = fixture
    const tabId = 'team-prepare-tab'
    const leafId = '77777777-7777-4777-8777-777777777777'
    runtime.continueAdmission.resolve()
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
    const create = () =>
      runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
        tabId,
        leafId,
        keepPaneOnStartFailure: true,
        presentation: 'background'
      })
    try {
      spawn.mockRejectedValueOnce(
        Object.assign(new Error('The initial provider outcome is unknown.'), {
          agentSessionOperationOutcome: 'unknown'
        })
      )
      await expect(create()).rejects.toThrow('The initial provider outcome is unknown.')
      const previous = runtime.getRetainedTerminalStart(TEST_WORKTREE_ID, tabId, leafId)!
      expect(previous.status).toBe('starting')
      const layout = structuredClone(getSession().terminalLayoutsByTabId[tabId])
      const settings = runtimeStore.getSettings()
      const mode = vi.spyOn(runtimeStore, 'getSettings').mockReturnValue({
        ...getDefaultSettings('/tmp/layout-pane-replacement'),
        ...settings,
        claudeAgentTeamsMode: 'native-panes-shim'
      })
      const mkdir = vi
        .mocked(fsPromises.mkdir)
        .mockRejectedValue(new Error('Could not prepare the terminal team shim.'))
      try {
        const failure = await runtime
          .createTerminal(`id:${TEST_WORKTREE_ID}`, {
            tabId,
            leafId,
            command: 'claude',
            env: {
              ORCA_AGENT_TEAMS_SHIM_BIN: '/fixture/orca',
              ORCA_AGENT_TEAMS_TEAM_ID: ''
            },
            keepPaneOnStartFailure: true,
            presentation: 'background'
          })
          .catch((error: unknown) => error)
        expect(mkdir).toHaveBeenCalledWith(
          expect.stringContaining('/.orca/claude-agent-teams-bin'),
          { recursive: true }
        )
        expect(failure).toBeInstanceOf(RetainedTerminalStartError)
        expect(runtime.getRetainedTerminalStartupDestinations()).toMatchObject([
          {
            start: {
              tabId,
              leafId,
              status: 'failed',
              reason: 'Could not prepare the terminal team shim.'
            },
            layout
          }
        ])
        expect(
          runtime.getRetainedTerminalStart(TEST_WORKTREE_ID, tabId, leafId)?.startSequence
        ).toBeGreaterThan(previous.startSequence)
        expect(spawn).toHaveBeenCalledOnce()
      } finally {
        mkdir.mockRestore()
        mode.mockRestore()
      }
      spawn.mockResolvedValueOnce({ id: 'replacement-pty', incarnationId: 'fresh-incarnation' })
      await expect(create()).resolves.toMatchObject({ ptyId: 'replacement-pty' })
      expect(runtime.getRetainedTerminalStartupDestinations()).toEqual([])
      expect(getSession().terminalLayoutsByTabId[tabId]?.ptyIdsByLeafId?.[leafId]).toBe(
        'replacement-pty'
      )
      expect(spawn).toHaveBeenCalledTimes(2)
    } finally {
      fixture.restoreProvider()
    }
  }
)

it('preserves the committed binding when its later presentation throws', async () => {
  const fixture = layoutPaneReplacementController()
  const { runtime, spawn, getSession } = fixture
  runtime.continueAdmission.resolve()
  runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
  const publication = vi.spyOn(runtime, 'noteTerminalSpawnCommand').mockImplementationOnce(() => {
    throw new Error('Presentation unavailable')
  })
  try {
    spawn.mockResolvedValueOnce({ id: 'replacement-pty', incarnationId: 'fresh-incarnation' })
    await expect(
      runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
        tabId: 'committed-tab',
        leafId: '55555555-5555-4555-8555-555555555555',
        keepPaneOnStartFailure: true,
        presentation: 'background'
      })
    ).resolves.toMatchObject({ ptyId: 'replacement-pty' })
    expect(
      getSession().terminalLayoutsByTabId['committed-tab']?.ptyIdsByLeafId?.[
        '55555555-5555-4555-8555-555555555555'
      ]
    ).toBe('replacement-pty')
    expect(runtime.getRetainedTerminalStartupDestinations()).toEqual([])
    expect(spawn).toHaveBeenCalledOnce()
  } finally {
    publication.mockRestore()
    fixture.restoreProvider()
  }
})

it('keeps the ended binding and its precise failure when registration observes an exit after persistence', async () => {
  const fixture = layoutPaneReplacementController()
  const { runtime, runtimeStore, spawn, getSession } = fixture
  runtime.continueAdmission.resolve()
  runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
  const persist = runtimeStore.persistPtyBinding.getMockImplementation()!
  runtimeStore.persistPtyBinding.mockImplementationOnce(async (...args) => {
    const written = await persist(...args)
    await runtime.onPtyExit('replacement-pty', 1, 'fresh-incarnation', {
      providerExitObserved: true
    })
    return written
  })
  try {
    spawn.mockResolvedValueOnce({
      id: 'replacement-pty',
      incarnationId: 'fresh-incarnation',
      snapshot: 'ended output'
    })
    const failure = await runtime
      .createTerminal(`id:${TEST_WORKTREE_ID}`, {
        tabId: 'ended-tab',
        leafId: '66666666-6666-4666-8666-666666666666',
        keepPaneOnStartFailure: true,
        presentation: 'background'
      })
      .catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(Error)
    expect(failure).toBeInstanceOf(RetainedTerminalStartError)
    expect(failure).toMatchObject({ cause: { terminalExitIncarnationId: 'fresh-incarnation' } })
    expect(runtime.getPtyLivenessVerdict('replacement-pty')?.status).toBe('exited')
    expect(
      getSession().tabsByWorktree[TEST_WORKTREE_ID]?.some((tab) => tab.id === 'ended-tab')
    ).toBe(true)
    expect(runtime.getRetainedTerminalStartupDestinations()).toMatchObject([
      {
        start: { tabId: 'ended-tab', status: 'failed' },
        layout: { ptyIdsByLeafId: { '66666666-6666-4666-8666-666666666666': 'replacement-pty' } }
      }
    ])
    expect(spawn).toHaveBeenCalledOnce()
  } finally {
    fixture.restoreProvider()
  }
})
