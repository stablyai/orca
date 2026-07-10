import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const callMock = vi.fn()
const getTerminalHandleMock = vi.hoisted(() => vi.fn())
const originalTerminalHandle = process.env.ORCA_TERMINAL_HANDLE
const originalPaneKey = process.env.ORCA_PANE_KEY
function lifecycleGroupRecipientError(type: 'worker_done' | 'heartbeat'): string {
  return `${type} messages must be sent to a concrete coordinator terminal handle, not a group address.`
}

// Why: isolate the handler's flag-to-param mapping; printResult only writes output.
vi.mock('../format', () => ({ printResult: vi.fn() }))
vi.mock('../selectors', () => ({ getTerminalHandle: getTerminalHandleMock }))

import { ORCHESTRATION_HANDLERS } from './orchestration'
import { RuntimeClientError } from '../runtime-client'

function staleHandleError(): RuntimeClientError {
  return new RuntimeClientError('terminal_handle_stale', 'terminal_handle_stale')
}

// Queues the stale-handle remint chain shared by coordinator commands:
// stale terminal.show → resolvePane returns liveHandle → downstream RPC result.
function stubStaleHandleRemint(liveHandle: string, downstream: unknown): void {
  callMock
    .mockRejectedValueOnce(staleHandleError())
    .mockResolvedValueOnce({ result: { terminal: { handle: liveHandle } } })
    .mockResolvedValueOnce(downstream)
}

// Queues a stale terminal.show followed by a resolvePane remint that fails with `error`.
function stubStaleHandleRemintFailure(error: RuntimeClientError): void {
  callMock.mockRejectedValueOnce(staleHandleError()).mockRejectedValueOnce(error)
}

afterEach(() => {
  getTerminalHandleMock.mockReset()
  if (originalTerminalHandle === undefined) {
    delete process.env.ORCA_TERMINAL_HANDLE
  } else {
    process.env.ORCA_TERMINAL_HANDLE = originalTerminalHandle
  }
  if (originalPaneKey === undefined) {
    delete process.env.ORCA_PANE_KEY
  } else {
    process.env.ORCA_PANE_KEY = originalPaneKey
  }
})

describe('orchestration reset CLI handler', () => {
  beforeEach(() => {
    callMock.mockReset().mockResolvedValue({ result: { reset: 'all' } })
  })

  const invoke = (flags: Map<string, string | boolean>) =>
    ORCHESTRATION_HANDLERS['orchestration reset']({
      flags,
      client: { call: callMock },
      json: true
    } as never)

  it('sends all: true for a bare `reset` (no scope flag)', async () => {
    await invoke(new Map())
    expect(callMock).toHaveBeenCalledWith('orchestration.reset', {
      all: true,
      tasks: undefined,
      messages: undefined
    })
  })

  it('sends only the tasks scope for --tasks', async () => {
    await invoke(new Map([['tasks', true]]))
    expect(callMock).toHaveBeenCalledWith('orchestration.reset', {
      all: undefined,
      tasks: true,
      messages: undefined
    })
  })

  it('sends only the all scope for --all (no implicit extra scopes)', async () => {
    await invoke(new Map([['all', true]]))
    expect(callMock).toHaveBeenCalledWith('orchestration.reset', {
      all: true,
      tasks: undefined,
      messages: undefined
    })
  })
})

describe('orchestration send structured payload flags', () => {
  beforeEach(() => {
    callMock.mockReset().mockResolvedValue({ result: { message: { id: 'msg_1' } } })
    getTerminalHandleMock.mockReset()
    delete process.env.ORCA_TERMINAL_HANDLE
    delete process.env.ORCA_PANE_KEY
  })

  const invokeSend = (flags: Map<string, string | boolean>) =>
    ORCHESTRATION_HANDLERS['orchestration send']({
      flags,
      client: { call: callMock },
      cwd: '/tmp/repo',
      json: true
    } as never)

  it('serializes common worker payload fields as JSON', async () => {
    await invokeSend(
      new Map<string, string | boolean>([
        ['from', 'term_worker'],
        ['to', 'term_coord'],
        ['subject', 'done'],
        ['type', 'worker_done'],
        ['task-id', 'task_1'],
        ['dispatch-id', 'ctx_1'],
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
        filesModified: ['src/a.ts', 'src/b.ts'],
        reportPath: 'reports/done.md'
      }),
      devMode: false
    })
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
        ['type', 'worker_done']
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
      payload: undefined,
      devMode: false
    })
  })

  it('continues to use ORCA_TERMINAL_HANDLE as worker lifecycle sender authority', async () => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_worker_env'

    await invokeSend(
      new Map<string, string | boolean>([
        ['to', 'term_coord'],
        ['subject', 'done'],
        ['type', 'worker_done']
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
      payload: undefined,
      devMode: false
    })
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
          ['type', 'worker_done']
        ])
      )
    ).rejects.toMatchObject({
      code: 'no_active_sender_terminal',
      message: expect.stringContaining('Pass --from')
    })
    expect(callMock).not.toHaveBeenCalled()
  })
})

describe('orchestration dispatch coordinator handle', () => {
  beforeEach(() => {
    callMock.mockReset()
    getTerminalHandleMock.mockReset()
    delete process.env.ORCA_TERMINAL_HANDLE
    delete process.env.ORCA_PANE_KEY
  })

  const invokeDispatch = (flags: Map<string, string | boolean>) =>
    ORCHESTRATION_HANDLERS['orchestration dispatch']({
      flags,
      client: { call: callMock },
      cwd: '/tmp/repo',
      json: true
    } as never)

  const invokeDispatchShow = (flags: Map<string, string | boolean>) =>
    ORCHESTRATION_HANDLERS['orchestration dispatch-show']({
      flags,
      client: { call: callMock },
      cwd: '/tmp/repo',
      json: true
    } as never)

  const invokeRun = (flags: Map<string, string | boolean>) =>
    ORCHESTRATION_HANDLERS['orchestration run']({
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

  it('uses a live coordinator handle for orchestration runs', async () => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_stale_coord'
    process.env.ORCA_PANE_KEY = 'tab_coord:leaf_coord'
    stubStaleHandleRemint('term_live_coord', {
      result: { runId: 'run_1', status: 'running' }
    })
    getTerminalHandleMock.mockRejectedValue(new Error('active terminal fallback is unsafe'))

    await invokeRun(new Map<string, string | boolean>([['spec', 'run the plan']]))

    expect(callMock).toHaveBeenNthCalledWith(1, 'terminal.show', {
      terminal: 'term_stale_coord'
    })
    expect(callMock).toHaveBeenNthCalledWith(2, 'terminal.resolvePane', {
      paneKey: 'tab_coord:leaf_coord'
    })
    expect(callMock).toHaveBeenNthCalledWith(3, 'orchestration.run', {
      spec: 'run the plan',
      from: 'term_live_coord',
      pollIntervalMs: undefined,
      maxConcurrent: undefined,
      worktree: undefined
    })
  })
})

describe('orchestration task-create caller handle', () => {
  beforeEach(() => {
    callMock.mockReset()
    getTerminalHandleMock.mockReset()
    delete process.env.ORCA_TERMINAL_HANDLE
    delete process.env.ORCA_PANE_KEY
  })

  const invokeTaskCreate = (flags: Map<string, string | boolean>) =>
    ORCHESTRATION_HANDLERS['orchestration task-create']({
      flags,
      client: { call: callMock },
      cwd: '/tmp/repo',
      json: true
    } as never)

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
      callerTerminalHandle: 'term_creator'
    })
  })

  it('does not persist a stale env terminal handle as task creator', async () => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_stale'
    callMock
      .mockRejectedValueOnce(staleHandleError())
      .mockResolvedValueOnce({ result: { task: { id: 'task_1', status: 'ready' } } })
    getTerminalHandleMock.mockResolvedValue('term_wrong_active')

    await invokeTaskCreate(new Map<string, string | boolean>([['spec', 'do work']]))

    expect(callMock).toHaveBeenNthCalledWith(1, 'terminal.show', { terminal: 'term_stale' })
    expect(getTerminalHandleMock).not.toHaveBeenCalled()
    expect(callMock).toHaveBeenNthCalledWith(2, 'orchestration.taskCreate', {
      spec: 'do work',
      taskTitle: undefined,
      displayName: undefined,
      deps: undefined,
      parent: undefined,
      callerTerminalHandle: undefined
    })
  })

  it('does not fail task creation when env handle validation cannot inspect the graph', async () => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_creator'
    callMock
      .mockRejectedValueOnce(new RuntimeClientError('runtime_unavailable', 'runtime_unavailable'))
      .mockResolvedValueOnce({ result: { task: { id: 'task_1', status: 'ready' } } })

    await invokeTaskCreate(new Map<string, string | boolean>([['spec', 'do work']]))

    expect(callMock).toHaveBeenNthCalledWith(1, 'terminal.show', { terminal: 'term_creator' })
    expect(getTerminalHandleMock).not.toHaveBeenCalled()
    expect(callMock).toHaveBeenNthCalledWith(2, 'orchestration.taskCreate', {
      spec: 'do work',
      taskTitle: undefined,
      displayName: undefined,
      deps: undefined,
      parent: undefined,
      callerTerminalHandle: undefined
    })
  })

  it('omits caller handle when pane reminting cannot inspect the graph', async () => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_stale'
    process.env.ORCA_PANE_KEY = 'tab_creator:leaf_creator'
    stubStaleHandleRemintFailure(
      new RuntimeClientError('runtime_unavailable', 'runtime_unavailable')
    )
    callMock.mockResolvedValueOnce({ result: { task: { id: 'task_1', status: 'ready' } } })
    getTerminalHandleMock.mockResolvedValue('term_wrong_active')

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
      callerTerminalHandle: undefined
    })
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
      callerTerminalHandle: 'term_live'
    })
  })
})

describe('orchestration timeout flag validation', () => {
  const invalidTimeoutValues: [string, string | boolean][] = [
    ['missing', true],
    ['empty', ''],
    ['non-numeric', 'not-a-number'],
    ['zero', '0'],
    ['negative', '-1']
  ]

  beforeEach(() => {
    callMock.mockReset()
    delete process.env.ORCA_TERMINAL_HANDLE
    delete process.env.ORCA_PANE_KEY
  })

  const invokeCheck = (flags: Map<string, string | boolean>) =>
    ORCHESTRATION_HANDLERS['orchestration check']({
      flags,
      client: { call: callMock },
      cwd: '/tmp/repo',
      json: true
    } as never)

  const invokeAsk = (flags: Map<string, string | boolean>) =>
    ORCHESTRATION_HANDLERS['orchestration ask']({
      flags,
      client: { call: callMock },
      cwd: '/tmp/repo',
      json: true
    } as never)

  it.each(invalidTimeoutValues)('rejects invalid check --timeout-ms: %s', async (_label, value) => {
    const flags = new Map<string, string | boolean>([
      ['wait', true],
      ['timeout-ms', value]
    ])

    await expect(invokeCheck(flags)).rejects.toThrow(/--timeout-ms/)
    expect(callMock).not.toHaveBeenCalled()
  })

  it('passes a parsed check timeout into the RPC payload', async () => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_worker'
    callMock.mockResolvedValue({ result: { messages: [], count: 0 } })

    await invokeCheck(
      new Map<string, string | boolean>([
        ['wait', true],
        ['timeout-ms', '250']
      ])
    )

    expect(callMock).toHaveBeenCalledWith('orchestration.check', {
      terminal: 'term_worker',
      unread: undefined,
      all: undefined,
      types: undefined,
      inject: undefined,
      wait: true,
      timeoutMs: 250
    })
  })

  it.each(invalidTimeoutValues)('rejects invalid ask --timeout-ms: %s', async (_label, value) => {
    const flags = new Map<string, string | boolean>([
      ['to', 'term_coord'],
      ['question', 'Proceed?'],
      ['timeout-ms', value]
    ])

    await expect(invokeAsk(flags)).rejects.toThrow(/--timeout-ms/)
    expect(callMock).not.toHaveBeenCalled()
  })

  it('uses the parsed ask timeout for both runtime wait and client timeout', async () => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_worker'
    callMock.mockResolvedValue({
      result: {
        answer: 'yes',
        messageId: 'msg_1',
        threadId: 'thread_1',
        timedOut: false
      }
    })
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await invokeAsk(
      new Map<string, string | boolean>([
        ['to', 'term_coord'],
        ['question', 'Proceed?'],
        ['timeout-ms', '123']
      ])
    )

    expect(callMock).toHaveBeenCalledWith(
      'orchestration.ask',
      {
        to: 'term_coord',
        question: 'Proceed?',
        options: undefined,
        timeoutMs: 123,
        from: 'term_worker'
      },
      { timeoutMs: 5_123 }
    )
  })
})
