import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type CliFlagMap,
  callMock,
  getTerminalHandleMock,
  handlerInvoker,
  lifecycleGroupRecipientError,
  restoreTerminalIdentityEnv,
  staleHandleError,
  stubStaleHandleRemint,
  stubStaleHandleRemintFailure
} from './orchestration-handler-test-harness'

// Why: isolate the handler's flag-to-param mapping; printResult only writes output.
vi.mock('../format', () => ({ printResult: vi.fn() }))
vi.mock('../selectors', () => ({ getTerminalHandle: getTerminalHandleMock }))

import { ORCHESTRATION_HANDLERS } from './orchestration'
import { RuntimeClientError } from '../runtime-client'

afterEach(restoreTerminalIdentityEnv)

describe('orchestration send structured payload flags', () => {
  beforeEach(() => {
    callMock.mockReset().mockResolvedValue({ result: { lifecycle: { action: 'completed' } } })
    getTerminalHandleMock.mockReset()
    delete process.env.ORCA_TERMINAL_HANDLE
    delete process.env.ORCA_PANE_KEY
  })

  const invokeSend = handlerInvoker(ORCHESTRATION_HANDLERS['orchestration send'])

  it('serializes common worker payload fields as JSON', async () => {
    await invokeSend(
      new Map<string, string | boolean>([
        ['from', 'term_worker'],
        ['to', 'term_coord'],
        ['subject', 'done'],
        ['type', 'worker_done'],
        ['task-id', 'task_1'],
        ['dispatch-id', 'ctx_1'],
        ['outcome', 'succeeded'],
        ['files-modified', 'src/a.ts, src/b.ts'],
        ['report-path', 'reports/done.md']
      ])
    )

    expect(callMock).toHaveBeenCalledWith('orchestration.send', {
      from: 'term_worker',
      to: 'term_coord',
      subject: 'done',
      body: undefined,
      type: 'worker_done',
      priority: undefined,
      threadId: undefined,
      payload: JSON.stringify({
        taskId: 'task_1',
        dispatchId: 'ctx_1',
        outcome: 'succeeded',
        filesModified: ['src/a.ts', 'src/b.ts'],
        reportPath: 'reports/done.md'
      }),
      waitForLifecycleSettlement: true,
      devMode: false
    })
  })

  it('forwards multiline message bodies without normalization', async () => {
    const body = 'paragraph one line one\nparagraph one line two\n\nparagraph two'

    await invokeSend(
      new Map<string, string | boolean>([
        ['from', 'term_worker'],
        ['to', 'term_coord'],
        ['subject', 'multiline'],
        ['body', body]
      ])
    )

    expect(callMock).toHaveBeenCalledWith('orchestration.send', expect.objectContaining({ body }))
  })

  it('carries Dispatch authority in the RPC envelope instead of message params', async () => {
    await invokeSend(
      new Map<string, string | boolean>([
        ['from', 'term_worker'],
        ['subject', 'alive'],
        ['type', 'heartbeat'],
        ['dispatch-id', 'ctx_1'],
        ['dispatch-capability', 'dcap_secret'],
        ['retry-request', 'mutation_1']
      ])
    )

    expect(callMock).toHaveBeenCalledWith(
      'orchestration.send',
      expect.not.objectContaining({ dispatchCapability: expect.anything() }),
      { orchestrationCapability: 'dcap_secret', orchestrationRequestId: 'mutation_1' }
    )
  })

  it('rejects mixing raw payload with structured payload flags', async () => {
    await expect(
      invokeSend(
        new Map<string, string | boolean>([
          ['from', 'term_worker'],
          ['to', 'term_coord'],
          ['subject', 'done'],
          ['payload', '{"taskId":"task_1"}'],
          ['task-id', 'task_1']
        ])
      )
    ).rejects.toThrow(/structured payload/)
    expect(callMock).not.toHaveBeenCalled()
  })

  it('rejects worker_done group sends before resolving a sender handle', async () => {
    getTerminalHandleMock.mockRejectedValue(new Error('sender resolution should not run'))

    await expect(
      invokeSend(
        new Map<string, string | boolean>([
          ['to', '@all'],
          ['subject', 'done'],
          ['type', 'worker_done']
        ])
      )
    ).rejects.toMatchObject({
      code: 'invalid_argument',
      message: lifecycleGroupRecipientError('worker_done')
    })

    expect(getTerminalHandleMock).not.toHaveBeenCalled()
    expect(callMock).not.toHaveBeenCalled()
  })

  it('rejects heartbeat group sends before resolving a sender handle', async () => {
    getTerminalHandleMock.mockRejectedValue(new Error('sender resolution should not run'))

    await expect(
      invokeSend(
        new Map<string, string | boolean>([
          ['to', '@idle'],
          ['subject', 'alive'],
          ['type', 'heartbeat']
        ])
      )
    ).rejects.toMatchObject({
      code: 'invalid_argument',
      message: lifecycleGroupRecipientError('heartbeat')
    })

    expect(getTerminalHandleMock).not.toHaveBeenCalled()
    expect(callMock).not.toHaveBeenCalled()
  })

  it('continues to allow worker_done to a concrete terminal handle', async () => {
    await invokeSend(
      new Map<string, string | boolean>([
        ['from', 'term_worker'],
        ['to', 'term_coord'],
        ['subject', 'done'],
        ['type', 'worker_done'],
        ['outcome', 'succeeded']
      ])
    )

    expect(callMock).toHaveBeenCalledWith('orchestration.send', {
      from: 'term_worker',
      to: 'term_coord',
      subject: 'done',
      body: undefined,
      type: 'worker_done',
      priority: undefined,
      threadId: undefined,
      payload: JSON.stringify({ outcome: 'succeeded' }),
      waitForLifecycleSettlement: true,
      devMode: false
    })
  })

  it('sends lifecycle messages from ORCA_TERMINAL_HANDLE without a liveness probe', async () => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_worker_env'

    await invokeSend(
      new Map<string, string | boolean>([
        ['to', 'term_coord'],
        ['subject', 'done'],
        ['type', 'worker_done'],
        ['outcome', 'succeeded']
      ])
    )

    expect(callMock).toHaveBeenCalledTimes(1)
    expect(callMock).toHaveBeenCalledWith('orchestration.send', {
      from: 'term_worker_env',
      to: 'term_coord',
      subject: 'done',
      body: undefined,
      type: 'worker_done',
      priority: undefined,
      threadId: undefined,
      payload: JSON.stringify({ outcome: 'succeeded' }),
      waitForLifecycleSettlement: true,
      devMode: false
    })
  })

  it.each(['worker_done', 'heartbeat'] as const)(
    'never probes or remints a %s sender even when a pane key is set',
    async (type) => {
      process.env.ORCA_TERMINAL_HANDLE = 'term_worker_env'
      process.env.ORCA_PANE_KEY = 'tab_worker:leaf_worker'

      await invokeSend(
        new Map<string, string | boolean>([
          ['to', 'term_coord'],
          ['subject', 'update'],
          ['type', type],
          ...(type === 'worker_done' ? ([['outcome', 'succeeded']] as const) : [])
        ])
      )

      // Why: pre-payload-authority runtimes only complete a worker_done whose
      // sender equals the recorded (equally stale) assignee handle, and
      // coordinator replies route to the sender row the worker's env-handle
      // `check` actually reads — so lifecycle sends must stay env-verbatim.
      expect(callMock).toHaveBeenCalledTimes(1)
      expect(callMock).toHaveBeenCalledWith(
        'orchestration.send',
        expect.objectContaining({ from: 'term_worker_env' })
      )
    }
  )

  it('passes ORCA_PANE_KEY as the sender pane identity', async () => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_worker_env'
    process.env.ORCA_PANE_KEY = 'tab_worker:leaf_worker'

    await invokeSend(
      new Map<string, string | boolean>([
        ['to', 'term_coord'],
        ['subject', 'done'],
        ['type', 'worker_done'],
        ['outcome', 'succeeded']
      ])
    )

    expect(callMock).toHaveBeenCalledWith(
      'orchestration.send',
      expect.objectContaining({ senderPaneKey: 'tab_worker:leaf_worker' })
    )
  })

  it('reports sender resolution failure instead of raw no_active_terminal', async () => {
    getTerminalHandleMock.mockRejectedValue(
      new RuntimeClientError('no_active_terminal', 'no_active_terminal')
    )

    await expect(
      invokeSend(
        new Map<string, string | boolean>([
          ['to', 'term_coord'],
          ['subject', 'done'],
          ['type', 'worker_done'],
          ['outcome', 'succeeded']
        ])
      )
    ).rejects.toMatchObject({
      code: 'no_active_sender_terminal',
      message: expect.stringContaining('Pass --from')
    })
    expect(callMock).not.toHaveBeenCalled()
  })

  it.each(['worker_done', 'heartbeat'] as const)(
    'does not resolve an identity-less %s sender from the active terminal',
    async (type) => {
      getTerminalHandleMock.mockResolvedValue('term_active_coordinator')

      await expect(
        invokeSend(
          new Map<string, string | boolean>([
            ['to', 'term_coord'],
            ['subject', 'update'],
            ['type', type],
            ...(type === 'worker_done' ? ([['outcome', 'succeeded']] as const) : [])
          ])
        )
      ).rejects.toMatchObject({ code: 'no_active_sender_terminal' })

      expect(getTerminalHandleMock).not.toHaveBeenCalled()
      expect(callMock).not.toHaveBeenCalled()
    }
  )
})

describe('orchestration dispatch coordinator handle', () => {
  beforeEach(() => {
    callMock.mockReset()
    getTerminalHandleMock.mockReset()
    delete process.env.ORCA_TERMINAL_HANDLE
    delete process.env.ORCA_PANE_KEY
  })

  const invokeDispatch = handlerInvoker(ORCHESTRATION_HANDLERS['orchestration dispatch'])
  const invokeDispatchShow = handlerInvoker(ORCHESTRATION_HANDLERS['orchestration dispatch-show'])
  const invokeRun = handlerInvoker(ORCHESTRATION_HANDLERS['orchestration coordinator-start'])

  it('remints a stale coordinator env handle from the caller pane key', async () => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_stale_coord'
    process.env.ORCA_PANE_KEY = 'tab_coord:leaf_coord'
    stubStaleHandleRemint('term_live_coord', {
      result: { dispatch: { id: 'ctx_1', task_id: 'task_1', status: 'dispatched' } }
    })
    getTerminalHandleMock.mockRejectedValue(new Error('active terminal fallback is unsafe'))

    await invokeDispatch(
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
      invokeDispatch(
        new Map<string, string | boolean>([
          ['task', 'task_1'],
          ['to', 'term_worker']
        ])
      )
    ).rejects.toMatchObject({
      code: 'no_active_sender_terminal'
    })

    expect(callMock).toHaveBeenCalledTimes(1)
    expect(getTerminalHandleMock).not.toHaveBeenCalled()
  })

  it('propagates unexpected caller pane remint failures for coordinator commands', async () => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_stale_coord'
    process.env.ORCA_PANE_KEY = 'tab_coord:leaf_coord'
    stubStaleHandleRemintFailure(
      new RuntimeClientError('runtime_unavailable', 'runtime_unavailable')
    )
    getTerminalHandleMock.mockResolvedValue('term_wrong_active')

    await expect(
      invokeDispatch(
        new Map<string, string | boolean>([
          ['task', 'task_1'],
          ['to', 'term_worker']
        ])
      )
    ).rejects.toMatchObject({
      code: 'runtime_unavailable'
    })

    expect(callMock).toHaveBeenNthCalledWith(1, 'terminal.show', {
      terminal: 'term_stale_coord'
    })
    expect(callMock).toHaveBeenNthCalledWith(2, 'terminal.resolvePane', {
      paneKey: 'tab_coord:leaf_coord'
    })
    expect(callMock).toHaveBeenCalledTimes(2)
    expect(getTerminalHandleMock).not.toHaveBeenCalled()
  })

  it('uses a live coordinator handle for dispatch-show preamble previews', async () => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_stale_coord'
    process.env.ORCA_PANE_KEY = 'tab_coord:leaf_coord'
    stubStaleHandleRemint('term_live_coord', {
      result: { dispatch: null, preamble: 'preamble' }
    })
    getTerminalHandleMock.mockRejectedValue(new Error('active terminal fallback is unsafe'))

    await invokeDispatchShow(
      new Map<string, string | boolean>([
        ['task', 'task_1'],
        ['preamble', true]
      ])
    )

    expect(callMock).toHaveBeenNthCalledWith(1, 'terminal.show', {
      terminal: 'term_stale_coord'
    })
    expect(callMock).toHaveBeenNthCalledWith(2, 'terminal.resolvePane', {
      paneKey: 'tab_coord:leaf_coord'
    })
    expect(callMock).toHaveBeenNthCalledWith(3, 'orchestration.dispatchShow', {
      task: 'task_1',
      preamble: true,
      from: 'term_live_coord',
      devMode: false
    })
  })

  it('retires the legacy coordinator command without runtime effects', async () => {
    await expect(
      invokeRun(new Map<string, string | boolean>([['spec', 'run the plan']]))
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

describe('orchestration dispatch Forget + raw read CLI handlers (W-T2)', () => {
  beforeEach(() => {
    callMock.mockReset()
  })

  const invoke = (key: string, flags: CliFlagMap) =>
    handlerInvoker(ORCHESTRATION_HANDLERS[key])(flags)

  it('dispatch-forget invokes dispatchForget with the task and expected failure id', async () => {
    callMock.mockResolvedValue({
      dispatch: { id: 'ctx_1', task_id: 'task_1', status: 'forgotten' }
    })

    await invoke(
      'orchestration dispatch-forget',
      new Map<string, string | boolean>([
        ['task', 'task_1'],
        ['expected-failure-id', 'fail-1'],
        ['from', 'term_coord'],
        ['run', 'run_1']
      ])
    )

    expect(callMock).toHaveBeenCalledWith('orchestration.dispatchForget', {
      task: 'task_1',
      run: 'run_1',
      from: 'term_coord',
      expectedFailureId: 'fail-1'
    })
  })

  it('dispatch-forget omits expectedFailureId when the flag is absent', async () => {
    callMock.mockResolvedValue({
      dispatch: { id: 'ctx_1', task_id: 'task_1', status: 'forgotten' }
    })

    await invoke(
      'orchestration dispatch-forget',
      new Map<string, string | boolean>([
        ['task', 'task_1'],
        ['from', 'term_coord']
      ])
    )

    expect(callMock).toHaveBeenCalledWith('orchestration.dispatchForget', {
      task: 'task_1',
      run: undefined,
      from: 'term_coord',
      expectedFailureId: undefined
    })
  })

  // Owner authorization is Run-scoped, so an unattested coordinator terminal must
  // still send a resolved handle rather than relying on the envelope fallback.
  it('dispatch-forget sends the coordinator handle resolved from the live terminal', async () => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_env'
    callMock
      .mockResolvedValueOnce({ result: { terminal: { handle: 'term_env' } } })
      .mockResolvedValueOnce({
        dispatch: { id: 'ctx_1', task_id: 'task_1', status: 'forgotten' }
      })

    await invoke(
      'orchestration dispatch-forget',
      new Map<string, string | boolean>([['task', 'task_1']])
    )

    expect(callMock).toHaveBeenCalledWith('terminal.show', { terminal: 'term_env' })
    expect(callMock).toHaveBeenCalledWith('orchestration.dispatchForget', {
      task: 'task_1',
      run: undefined,
      from: 'term_env',
      expectedFailureId: undefined
    })
  })

  it('dispatch-show --raw reads the un-projected status via dispatchShowRaw (never the projected read)', async () => {
    callMock.mockResolvedValue({
      dispatch: { id: 'ctx_1', task_id: 'task_1', status: 'forgotten', agent_launch_failure: null }
    })

    await invoke(
      'orchestration dispatch-show',
      new Map<string, string | boolean>([
        ['task', 'task_1'],
        ['raw', true]
      ])
    )

    expect(callMock).toHaveBeenCalledWith('orchestration.dispatchShowRaw', { task: 'task_1' })
    expect(callMock).not.toHaveBeenCalledWith('orchestration.dispatchShow', expect.anything())
  })
})

describe('orchestration task-create caller handle', () => {
  beforeEach(() => {
    callMock.mockReset()
    getTerminalHandleMock.mockReset()
    delete process.env.ORCA_TERMINAL_HANDLE
    delete process.env.ORCA_PANE_KEY
  })

  const invokeTaskCreate = handlerInvoker(ORCHESTRATION_HANDLERS['orchestration task-create'])

  it('records a live env terminal handle as task creator', async () => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_creator'
    callMock
      .mockResolvedValueOnce({ result: { terminal: { handle: 'term_creator' } } })
      .mockResolvedValueOnce({ result: { task: { id: 'task_1', status: 'ready' } } })

    await invokeTaskCreate(new Map<string, string | boolean>([['spec', 'do work']]))

    expect(callMock).toHaveBeenNthCalledWith(1, 'terminal.show', { terminal: 'term_creator' })
    expect(callMock).toHaveBeenNthCalledWith(2, 'orchestration.taskCreate', {
      spec: 'do work',
      taskTitle: undefined,
      displayName: undefined,
      deps: undefined,
      parent: undefined,
      run: undefined,
      callerTerminalHandle: 'term_creator'
    })
  })

  it('fails closed when a stale task creator handle cannot be reminted', async () => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_stale'
    callMock.mockRejectedValueOnce(staleHandleError())
    getTerminalHandleMock.mockResolvedValue('term_wrong_active')

    await expect(
      invokeTaskCreate(new Map<string, string | boolean>([['spec', 'do work']]))
    ).rejects.toMatchObject({ code: 'no_active_sender_terminal' })

    expect(callMock).toHaveBeenNthCalledWith(1, 'terminal.show', { terminal: 'term_stale' })
    expect(getTerminalHandleMock).not.toHaveBeenCalled()
    expect(callMock).toHaveBeenCalledTimes(1)
  })

  it('propagates runtime unavailability while proving the bound coordinator', async () => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_creator'
    callMock.mockRejectedValueOnce(
      new RuntimeClientError('runtime_unavailable', 'runtime_unavailable')
    )

    await expect(
      invokeTaskCreate(new Map<string, string | boolean>([['spec', 'do work']]))
    ).rejects.toMatchObject({ code: 'runtime_unavailable' })

    expect(callMock).toHaveBeenNthCalledWith(1, 'terminal.show', { terminal: 'term_creator' })
    expect(getTerminalHandleMock).not.toHaveBeenCalled()
    expect(callMock).toHaveBeenCalledTimes(1)
  })

  it('propagates runtime unavailability while reminting the bound coordinator', async () => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_stale'
    process.env.ORCA_PANE_KEY = 'tab_creator:leaf_creator'
    stubStaleHandleRemintFailure(
      new RuntimeClientError('runtime_unavailable', 'runtime_unavailable')
    )
    getTerminalHandleMock.mockResolvedValue('term_wrong_active')

    await expect(
      invokeTaskCreate(new Map<string, string | boolean>([['spec', 'do work']]))
    ).rejects.toMatchObject({ code: 'runtime_unavailable' })

    expect(callMock).toHaveBeenNthCalledWith(1, 'terminal.show', { terminal: 'term_stale' })
    expect(callMock).toHaveBeenNthCalledWith(2, 'terminal.resolvePane', {
      paneKey: 'tab_creator:leaf_creator'
    })
    expect(getTerminalHandleMock).not.toHaveBeenCalled()
    expect(callMock).toHaveBeenCalledTimes(2)
  })

  it('propagates unexpected caller pane remint failures for task creation', async () => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_stale'
    process.env.ORCA_PANE_KEY = 'tab_creator:leaf_creator'
    stubStaleHandleRemintFailure(new RuntimeClientError('permission_denied', 'denied'))
    getTerminalHandleMock.mockResolvedValue('term_wrong_active')

    await expect(
      invokeTaskCreate(new Map<string, string | boolean>([['spec', 'do work']]))
    ).rejects.toMatchObject({
      code: 'permission_denied'
    })

    expect(callMock).toHaveBeenNthCalledWith(1, 'terminal.show', { terminal: 'term_stale' })
    expect(callMock).toHaveBeenNthCalledWith(2, 'terminal.resolvePane', {
      paneKey: 'tab_creator:leaf_creator'
    })
    expect(callMock).toHaveBeenCalledTimes(2)
    expect(getTerminalHandleMock).not.toHaveBeenCalled()
  })

  it('propagates unexpected env handle validation failures', async () => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_creator'
    callMock.mockRejectedValueOnce(new RuntimeClientError('permission_denied', 'denied'))

    await expect(
      invokeTaskCreate(new Map<string, string | boolean>([['spec', 'do work']]))
    ).rejects.toMatchObject({
      code: 'permission_denied'
    })

    expect(callMock).toHaveBeenCalledTimes(1)
  })

  it('remints a stale task creator env handle from the caller pane key', async () => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_stale'
    process.env.ORCA_PANE_KEY = 'tab_creator:leaf_creator'
    stubStaleHandleRemint('term_live', {
      result: { task: { id: 'task_1', status: 'ready' } }
    })
    getTerminalHandleMock.mockRejectedValue(new Error('active terminal fallback is unsafe'))

    await invokeTaskCreate(new Map<string, string | boolean>([['spec', 'do work']]))

    expect(callMock).toHaveBeenNthCalledWith(1, 'terminal.show', { terminal: 'term_stale' })
    expect(callMock).toHaveBeenNthCalledWith(2, 'terminal.resolvePane', {
      paneKey: 'tab_creator:leaf_creator'
    })
    expect(getTerminalHandleMock).not.toHaveBeenCalled()
    expect(callMock).toHaveBeenNthCalledWith(3, 'orchestration.taskCreate', {
      spec: 'do work',
      taskTitle: undefined,
      displayName: undefined,
      deps: undefined,
      parent: undefined,
      run: undefined,
      callerTerminalHandle: 'term_live'
    })
  })
})
