import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const callMock = vi.fn()
const getTerminalHandleMock = vi.hoisted(() => vi.fn())
const printResultMock = vi.hoisted(() => vi.fn())
const originalTerminalHandle = process.env.ORCA_TERMINAL_HANDLE
const originalPaneKey = process.env.ORCA_PANE_KEY
const originalLaunchToken = process.env.ORCA_AGENT_LAUNCH_TOKEN

vi.mock('../format', () => ({ printResult: printResultMock }))
vi.mock('../selectors', () => ({ getTerminalHandle: getTerminalHandleMock }))

import { ORCHESTRATION_HANDLERS } from './orchestration'
import { RuntimeClientError } from '../runtime-client'

function staleHandleError(): RuntimeClientError {
  return new RuntimeClientError('terminal_handle_stale', 'terminal_handle_stale')
}

function stubStaleHandleRemint(liveHandle: string, downstream: unknown): void {
  callMock
    .mockRejectedValueOnce(staleHandleError())
    .mockResolvedValueOnce({ result: { terminal: { handle: liveHandle } } })
    .mockResolvedValueOnce(downstream)
}

function stubStaleHandleRemintFailure(error: RuntimeClientError): void {
  callMock.mockRejectedValueOnce(staleHandleError()).mockRejectedValueOnce(error)
}

afterEach(() => {
  restoreEnv('ORCA_TERMINAL_HANDLE', originalTerminalHandle)
  restoreEnv('ORCA_PANE_KEY', originalPaneKey)
  restoreEnv('ORCA_AGENT_LAUNCH_TOKEN', originalLaunchToken)
})

describe('orchestration dispatch coordinator handle', () => {
  beforeEach(() => {
    callMock.mockReset()
    getTerminalHandleMock.mockReset()
    printResultMock.mockReset()
    delete process.env.ORCA_TERMINAL_HANDLE
    delete process.env.ORCA_PANE_KEY
  })

  const invoke = (
    command: 'orchestration dispatch' | 'orchestration dispatch-show',
    flags: Map<string, string | boolean>
  ) =>
    ORCHESTRATION_HANDLERS[command]({
      flags,
      client: { call: callMock },
      cwd: '/tmp/repo',
      json: true
    } as never)

  it('remints a stale coordinator env handle from the caller pane key', async () => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_stale_coord'
    process.env.ORCA_PANE_KEY = 'tab_coord:leaf_coord'
    stubStaleHandleRemint('term_live_coord', {
      result: { dispatch: { id: 'ctx_1', task_id: 'task_1', status: 'dispatched' } }
    })
    getTerminalHandleMock.mockRejectedValue(new Error('active terminal fallback is unsafe'))

    await invoke(
      'orchestration dispatch',
      new Map<string, string | boolean>([
        ['task', 'task_1'],
        ['to', 'term_worker'],
        ['inject', true]
      ])
    )

    expect(callMock).toHaveBeenNthCalledWith(1, 'terminal.show', {
      terminal: 'term_stale_coord'
    })
    expect(callMock).toHaveBeenNthCalledWith(2, 'terminal.resolvePane', {
      paneKey: 'tab_coord:leaf_coord'
    })
    expect(getTerminalHandleMock).not.toHaveBeenCalled()
    expect(callMock).toHaveBeenNthCalledWith(3, 'orchestration.dispatch', {
      task: 'task_1',
      to: 'term_worker',
      from: 'term_live_coord',
      inject: true,
      dryRun: undefined,
      returnPreamble: undefined,
      devMode: false
    })
  })

  it('rejects stale coordinator env handles when the caller pane cannot be proven', async () => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_stale_coord'
    callMock.mockRejectedValueOnce(staleHandleError())
    getTerminalHandleMock.mockResolvedValue('term_wrong_active')

    await expect(
      invoke(
        'orchestration dispatch',
        new Map<string, string | boolean>([
          ['task', 'task_1'],
          ['to', 'term_worker']
        ])
      )
    ).rejects.toMatchObject({ code: 'no_active_sender_terminal' })
    expect(callMock).toHaveBeenCalledTimes(1)
    expect(getTerminalHandleMock).not.toHaveBeenCalled()
  })

  it('propagates unexpected caller pane remint failures', async () => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_stale_coord'
    process.env.ORCA_PANE_KEY = 'tab_coord:leaf_coord'
    stubStaleHandleRemintFailure(
      new RuntimeClientError('runtime_unavailable', 'runtime_unavailable')
    )

    await expect(
      invoke('orchestration dispatch', new Map([['task', 'task_1']]))
    ).rejects.toMatchObject({ code: 'runtime_unavailable' })
    expect(callMock).toHaveBeenCalledTimes(2)
  })

  it('requests secret-safe recovery with the reminted caller evidence', async () => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_stale_coord'
    process.env.ORCA_PANE_KEY = 'tab_coord:leaf_coord'
    process.env.ORCA_AGENT_LAUNCH_TOKEN = 'launch-token'
    stubStaleHandleRemint('term_live_coord', {
      result: { dispatch: null, preamble: 'preamble' }
    })

    await invoke(
      'orchestration dispatch-show',
      new Map<string, string | boolean>([
        ['task', 'task_1'],
        ['preamble', true]
      ])
    )

    expect(callMock).toHaveBeenNthCalledWith(
      3,
      'orchestration.dispatchShow',
      {
        task: 'task_1',
        preamble: true,
        recoverCapability: true,
        from: 'term_live_coord',
        devMode: false
      },
      {
        orchestrationCompatibilityEvidence: {
          terminalHandle: 'term_live_coord',
          paneKey: 'tab_coord:leaf_coord',
          launchToken: 'launch-token'
        }
      }
    )
  })

  it('rejects an old runtime tokenless response for an active assigned worker', async () => {
    process.env.ORCA_PANE_KEY = 'tab_worker:leaf_worker'
    process.env.ORCA_AGENT_LAUNCH_TOKEN = 'launch-token'
    callMock.mockResolvedValueOnce({
      result: {
        dispatch: {
          id: 'ctx_1',
          task_id: 'task_1',
          status: 'dispatched',
          assignee_handle: 'term_worker'
        },
        preamble: 'tokenless old-runtime preamble'
      }
    })

    await expect(
      invoke(
        'orchestration dispatch-show',
        new Map<string, string | boolean>([
          ['task', 'task_1'],
          ['preamble', true],
          ['from', 'term_worker']
        ])
      )
    ).rejects.toMatchObject({
      code: 'dispatch_capability_unavailable',
      message: expect.stringContaining('ask the coordinator to redispatch')
    })
  })

  it('keeps old-runtime coordinator preamble inspection tokenless', async () => {
    callMock.mockResolvedValueOnce({
      result: {
        dispatch: {
          id: 'ctx_1',
          task_id: 'task_1',
          status: 'dispatched',
          assignee_handle: 'term_worker'
        },
        preamble: 'tokenless old-runtime coordinator inspection'
      }
    })

    await expect(
      invoke(
        'orchestration dispatch-show',
        new Map<string, string | boolean>([
          ['task', 'task_1'],
          ['preamble', true],
          ['from', 'term_coordinator']
        ])
      )
    ).resolves.toBeUndefined()
  })

  it('keeps tokenless inspection usable when an old runtime omits assignee identity', async () => {
    getTerminalHandleMock.mockResolvedValue('term_coordinator')
    callMock.mockResolvedValueOnce({
      result: {
        dispatch: { id: 'ctx_1', task_id: 'task_1', status: 'dispatched' },
        preamble: 'tokenless old-runtime inspection'
      }
    })

    await expect(
      invoke(
        'orchestration dispatch-show',
        new Map<string, string | boolean>([
          ['task', 'task_1'],
          ['preamble', true]
        ])
      )
    ).resolves.toBeUndefined()
  })

  it('accepts a recovered preamble for the active assignee', async () => {
    callMock.mockResolvedValueOnce({
      result: {
        dispatch: {
          id: 'ctx_1',
          task_id: 'task_1',
          status: 'dispatched',
          assignee_handle: 'term_worker'
        },
        preamble: 'authorized recovered preamble',
        recovery: 'recovered'
      }
    })

    await expect(
      invoke(
        'orchestration dispatch-show',
        new Map<string, string | boolean>([
          ['task', 'task_1'],
          ['preamble', true],
          ['from', 'term_worker']
        ])
      )
    ).resolves.toBeUndefined()
  })

  it('rejects an unavailable recovery even when the caller is not the assignee', async () => {
    callMock.mockResolvedValueOnce({
      result: {
        dispatch: {
          id: 'ctx_1',
          task_id: 'task_1',
          status: 'dispatched',
          assignee_handle: 'term_worker'
        },
        preamble: 'unavailable recovered preamble',
        recovery: 'unavailable'
      }
    })

    await expect(
      invoke(
        'orchestration dispatch-show',
        new Map<string, string | boolean>([
          ['task', 'task_1'],
          ['preamble', true],
          ['from', 'term_coordinator']
        ])
      )
    ).rejects.toMatchObject({ code: 'dispatch_capability_unavailable' })
    expect(printResultMock).not.toHaveBeenCalled()
  })

  it.each([undefined, 'inspection'] as const)(
    'rejects a reminted worker tokenless response with recovery %s',
    async (recovery) => {
      process.env.ORCA_TERMINAL_HANDLE = 'term_stale_worker'
      process.env.ORCA_PANE_KEY = 'tab_worker:leaf_worker'
      process.env.ORCA_AGENT_LAUNCH_TOKEN = 'launch-token'
      stubStaleHandleRemint('term_live_worker', {
        result: {
          dispatch: {
            id: 'ctx_1',
            task_id: 'task_1',
            status: 'dispatched',
            assignee_handle: 'term_stale_worker'
          },
          preamble: 'tokenless reminted-worker preamble',
          ...(recovery ? { recovery } : {})
        }
      })

      await expect(
        invoke(
          'orchestration dispatch-show',
          new Map<string, string | boolean>([
            ['task', 'task_1'],
            ['preamble', true]
          ])
        )
      ).rejects.toMatchObject({ code: 'dispatch_capability_unavailable' })
    }
  )

  it.each([undefined, 'inspection'] as const)(
    'rejects explicit reminted worker tokenless response with recovery %s',
    async (recovery) => {
      process.env.ORCA_PANE_KEY = 'tab_reminted:11111111-1111-4111-8111-111111111111'
      process.env.ORCA_AGENT_LAUNCH_TOKEN = 'launch-token'
      callMock.mockResolvedValueOnce({
        result: {
          dispatch: {
            id: 'ctx_1',
            task_id: 'task_1',
            status: 'dispatched',
            assignee_handle: 'term_stale_worker',
            assignee_pane_key: 'tab_original:11111111-1111-4111-8111-111111111111'
          },
          preamble: 'tokenless explicit-reminted-worker preamble',
          ...(recovery ? { recovery } : {})
        }
      })

      await expect(
        invoke(
          'orchestration dispatch-show',
          new Map<string, string | boolean>([
            ['task', 'task_1'],
            ['preamble', true],
            ['from', 'term_live_worker']
          ])
        )
      ).rejects.toMatchObject({ code: 'dispatch_capability_unavailable' })
    }
  )

  it('retires the legacy coordinator command without runtime effects', async () => {
    await expect(
      ORCHESTRATION_HANDLERS['orchestration coordinator-start']({
        flags: new Map([['spec', 'run the plan']]),
        client: { call: callMock },
        cwd: '/tmp/repo',
        json: true
      } as never)
    ).rejects.toMatchObject({
      code: 'orchestration_migration_required',
      data: {
        reason: 'command_retired',
        effectsApplied: false,
        nextCommandArgs: ['skills', 'get', 'orchestration', '--full']
      }
    })
    expect(callMock).not.toHaveBeenCalled()
  })
})

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name]
  } else {
    process.env[name] = value
  }
}
