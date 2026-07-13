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
import { printResult } from '../format'

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

  it('sends lifecycle messages from ORCA_TERMINAL_HANDLE without a liveness probe', async () => {
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

  it.each(['worker_done', 'heartbeat'] as const)(
    'never probes or remints a %s sender even when a pane key is set',
    async (type) => {
      process.env.ORCA_TERMINAL_HANDLE = 'term_worker_env'
      process.env.ORCA_PANE_KEY = 'tab_worker:leaf_worker'

      await invokeSend(
        new Map<string, string | boolean>([
          ['to', 'term_coord'],
          ['subject', 'update'],
          ['type', type]
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
        ['type', 'worker_done']
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

  it('passes a parsed check timeout and peek mode into the RPC payload', async () => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_worker'
    callMock.mockResolvedValue({ result: { messages: [], count: 0 } })

    await invokeCheck(
      new Map<string, string | boolean>([
        ['wait', true],
        ['peek', true],
        ['timeout-ms', '250']
      ])
    )

    // Why: --peek rides with unread:false so pre-peek runtimes fall back to
    // the non-consuming all mode instead of the destructive mark-read default.
    expect(callMock).toHaveBeenCalledWith('orchestration.check', {
      terminal: 'term_worker',
      unread: false,
      peek: true,
      all: undefined,
      types: undefined,
      inject: undefined,
      wait: true,
      timeoutMs: 250
    })
  })

  it('filters already-read rows from a peek response for pre-peek runtimes', async () => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_worker'
    callMock.mockResolvedValue({
      result: {
        messages: [
          { id: 'msg_old', from_handle: 'a', subject: 'seen', read: 1 },
          { id: 'msg_new', from_handle: 'a', subject: 'fresh', read: 0 }
        ],
        count: 2,
        formatted: 'banners built from all rows'
      }
    })
    vi.mocked(printResult).mockClear()

    await invokeCheck(new Map<string, string | boolean>([['peek', true]]))

    const response = vi.mocked(printResult).mock.calls[0]?.[0] as {
      result: { messages: { id: string }[]; count: number; formatted?: string }
    }
    expect(response.result.messages.map((m) => m.id)).toEqual(['msg_new'])
    expect(response.result.count).toBe(1)
    // Why: the pre-peek runtime built `formatted` from all rows, including
    // the read one the filter just removed.
    expect(response.result.formatted).toBeUndefined()
  })

  it('rejects combined read modes before calling the runtime', async () => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_worker'
    callMock.mockClear()

    await expect(
      invokeCheck(
        new Map<string, string | boolean>([
          ['unread', true],
          ['peek', true]
        ])
      )
    ).rejects.toMatchObject({
      code: 'invalid_argument',
      message: expect.stringContaining('read mode')
    })
    expect(callMock).not.toHaveBeenCalled()
  })

  it('warns when a pre-peek runtime returned a full 100-row page', async () => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_worker'
    const rows = Array.from({ length: 100 }, (_, i) => ({
      id: `msg_${i}`,
      from_handle: 'a',
      subject: `s${i}`,
      read: i === 0 ? 0 : 1
    }))
    callMock.mockResolvedValue({ result: { messages: rows, count: 100 } })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await invokeCheck(new Map<string, string | boolean>([['peek', true]]))

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('newest 100 messages'))
    errorSpy.mockRestore()
  })

  it('fails --peek --wait against a runtime that returned only read rows', async () => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_worker'
    callMock.mockResolvedValue({
      result: {
        messages: [{ id: 'msg_old', from_handle: 'a', subject: 'seen', read: 1 }],
        count: 1
      }
    })

    await expect(
      invokeCheck(
        new Map<string, string | boolean>([
          ['peek', true],
          ['wait', true]
        ])
      )
    ).rejects.toMatchObject({ code: 'peek_wait_unsupported' })
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

describe('orchestration task-list brief output', () => {
  it('requests server-side brief and falls back client-side for older runtimes', async () => {
    callMock.mockReset().mockResolvedValue({
      result: {
        // No spec_truncated field — the pre-brief-runtime signature.
        tasks: [{ id: 'task_1', spec: `First line\n${'detail '.repeat(40)}`, status: 'ready' }],
        count: 1
      }
    })
    vi.mocked(printResult).mockClear()

    await ORCHESTRATION_HANDLERS['orchestration task-list']({
      flags: new Map([['brief', true]]),
      client: { call: callMock },
      json: true
    } as never)

    expect(callMock).toHaveBeenCalledWith(
      'orchestration.taskList',
      expect.objectContaining({ brief: true })
    )
    const response = vi.mocked(printResult).mock.calls[0]?.[0] as {
      result: { tasks: { spec: string; spec_truncated: boolean }[] }
    }
    expect(response.result.tasks[0].spec).toHaveLength(160)
    expect(response.result.tasks[0].spec_truncated).toBe(true)
  })

  it('passes server-abbreviated rows through untouched', async () => {
    const serverTasks = [
      { id: 'task_1', spec: 'already brief…', status: 'ready', spec_truncated: true }
    ]
    callMock.mockReset().mockResolvedValue({ result: { tasks: serverTasks, count: 1 } })
    vi.mocked(printResult).mockClear()

    await ORCHESTRATION_HANDLERS['orchestration task-list']({
      flags: new Map([['brief', true]]),
      client: { call: callMock },
      json: true
    } as never)

    const response = vi.mocked(printResult).mock.calls[0]?.[0] as {
      result: { tasks: { spec: string; spec_truncated: boolean }[] }
    }
    // Why: re-abbreviating a server-truncated spec would flip spec_truncated
    // back to false (the truncated text fits the cap).
    expect(response.result.tasks).toBe(serverTasks)
  })
})
