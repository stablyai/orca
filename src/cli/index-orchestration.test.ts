import { describe, expect, it, vi } from 'vitest'

const {
  callMock,
  runtimeClientConstructorMock,
  serveOrcaAppMock,
  getDefaultUserDataPathMock,
  addEnvironmentFromPairingCodeMock,
  listEnvironmentsMock,
  spawnMock
} = vi.hoisted(() => ({
  callMock: vi.fn(),
  runtimeClientConstructorMock: vi.fn(),
  serveOrcaAppMock: vi.fn(),
  getDefaultUserDataPathMock: vi.fn(() => '/tmp/orca-user-data'),
  addEnvironmentFromPairingCodeMock: vi.fn(),
  listEnvironmentsMock: vi.fn(),
  spawnMock: vi.fn()
}))

vi.mock('./runtime-client', async () => {
  const { createRuntimeClientModuleMock } = await import('./index-test-harness.js')
  return createRuntimeClientModuleMock({
    callMock,
    runtimeClientConstructorMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock
  })
})

vi.mock('./runtime/environments', () => ({
  addEnvironmentFromPairingCode: addEnvironmentFromPairingCodeMock,
  listEnvironments: listEnvironmentsMock,
  removeEnvironment: vi.fn(),
  resolveEnvironment: vi.fn()
}))

vi.mock('child_process', async () => {
  const { createChildProcessModuleMock } = await import('./index-test-harness.js')
  return createChildProcessModuleMock(spawnMock)
})

import { main } from './index'
import { okFixture } from './test-fixtures'
import { useWorktreeAwarenessEnvironment } from './index-test-harness'

describe('orca cli worktree awareness', () => {
  useWorktreeAwarenessEnvironment({
    callMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock,
    addEnvironmentFromPairingCodeMock,
    listEnvironmentsMock,
    spawnMock
  })

  it('formats group orchestration sends in text mode', async () => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_sender'
    callMock.mockResolvedValueOnce({
      id: 'req_send',
      ok: true,
      result: {
        messages: [{ id: 'msg_1' }, { id: 'msg_2' }],
        recipients: 2
      },
      _meta: {
        runtimeId: 'runtime-1'
      }
    })
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['orchestration', 'send', '--to', '@all', '--subject', 'hello'], '/tmp/repo')

    expect(callMock).toHaveBeenCalledWith('orchestration.send', {
      from: 'term_sender',
      to: '@all',
      subject: 'hello',
      body: undefined,
      type: undefined,
      priority: undefined,
      threadId: undefined,
      payload: undefined,
      devMode: false
    })
    expect(logSpy).toHaveBeenCalledWith('Sent 2 messages to 2 recipients')
  })

  it('sends --delivery steer to the runtime', async () => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_sender'
    callMock.mockResolvedValueOnce({
      id: 'req_send',
      ok: true,
      result: { message: { id: 'msg_1' } },
      _meta: { runtimeId: 'runtime-1' }
    })
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      [
        'orchestration',
        'send',
        '--to',
        'dispatch:ctx_1',
        '--subject',
        'stop',
        '--delivery',
        'steer'
      ],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenCalledWith(
      'orchestration.send',
      expect.objectContaining({ to: 'dispatch:ctx_1', delivery: 'steer' })
    )
  })

  it.each([
    [['--delivery', 'restart'], '--delivery'],
    [['--delivery', 'steer', '--type', 'heartbeat'], 'heartbeat']
  ])('refuses send %j before any request', async (flags, named) => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_sender'
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['orchestration', 'send', '--subject', 'x', ...flags, '--json'], '/tmp/repo')

    expect(callMock).not.toHaveBeenCalled()
    expect(JSON.parse(String(logSpy.mock.calls[0]?.[0]))).toMatchObject({
      ok: false,
      error: { code: 'invalid_argument', message: expect.stringContaining(named) }
    })
    process.exitCode = undefined
  })

  it('refuses dispatch --delivery without --inject before any request', async () => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_sender'
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      [
        'orchestration',
        'dispatch',
        '--task',
        'task_1',
        '--to',
        'term_worker',
        '--delivery',
        'steer',
        '--json'
      ],
      '/tmp/repo'
    )

    expect(callMock).not.toHaveBeenCalled()
    expect(JSON.parse(String(logSpy.mock.calls[0]?.[0]))).toMatchObject({
      ok: false,
      error: { code: 'invalid_argument', message: expect.stringContaining('--inject') }
    })
    process.exitCode = undefined
  })

  it.each([
    ['queued', ' (task queued in the chat)'],
    ['accepted', ' (task sent)'],
    ['pending', ' (task handed to the chat; not taken yet)'],
    // A newer runtime's arm this CLI does not know, and an older runtime that sends none.
    ['steered', ''],
    [undefined, '']
  ])(
    'sends dispatch --delivery steer, and says how a chat took its task (%s)',
    async (delivery, said) => {
      process.env.ORCA_TERMINAL_HANDLE = 'term_sender'
      callMock.mockImplementation(async (method: string) => ({
        id: method,
        ok: true,
        result:
          method === 'orchestration.dispatch'
            ? {
                dispatch: { id: 'ctx_1', task_id: 'task_1', status: 'dispatched' },
                injected: true,
                ...(delivery ? { delivery } : {})
              }
            : { identity: { live: true } },
        _meta: { runtimeId: 'runtime-1' }
      }))
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

      await main(
        [
          'orchestration',
          'dispatch',
          '--task',
          'task_1',
          '--to',
          'term_worker',
          '--inject',
          '--delivery',
          'steer'
        ],
        '/tmp/repo'
      )

      expect(callMock).toHaveBeenCalledWith(
        'orchestration.dispatch',
        expect.objectContaining({ inject: true, delivery: 'steer' })
      )
      expect(logSpy).toHaveBeenCalledWith(`Dispatched task_1 -> ctx_1 [dispatched]${said}`)
    }
  )

  it("refuses an agent session's caller flag naming another caller before any request", async () => {
    // One chokepoint for every verb: the spec says which flag names the caller.
    process.env.ORCA_AGENT_SESSION_ID = 'f7a1c0de-1111-4222-8333-444455556666'
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      await main(['orchestration', 'check', '--terminal', 'term_sibling', '--json'], '/tmp/repo')
    } finally {
      delete process.env.ORCA_AGENT_SESSION_ID
    }

    expect(callMock).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(1)
    expect(JSON.parse(String(logSpy.mock.calls[0]?.[0]))).toMatchObject({
      ok: false,
      error: { code: 'consumer_fenced' }
    })
    process.exitCode = undefined
  })

  it('rejects no-flag orchestration reset before calling the runtime', async () => {
    await main(['orchestration', 'reset'], '/tmp/repo')

    expect(callMock).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(1)
  })

  it.each([
    {
      args: ['orchestration', 'reset', '--all'],
      params: { all: true, tasks: undefined, messages: undefined },
      reset: 'all'
    },
    {
      args: ['orchestration', 'reset', '--tasks'],
      params: { all: undefined, tasks: true, messages: undefined },
      reset: 'tasks'
    },
    {
      args: ['orchestration', 'reset', '--messages'],
      params: { all: undefined, tasks: undefined, messages: true },
      reset: 'messages'
    }
  ])('passes explicit reset flags through for $args', async ({ args, params, reset }) => {
    callMock.mockResolvedValueOnce(okFixture('req_reset', { reset }))
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(args, '/tmp/repo')

    expect(callMock).toHaveBeenCalledWith('orchestration.reset', params)
  })

  it.each([
    ['orchestration', 'reset', '--tasks', '--messages'],
    ['orchestration', 'reset', '--all', '--tasks']
  ])('rejects conflicting reset scopes for $args', async (...args) => {
    await main(args, '/tmp/repo')

    expect(callMock).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(1)
  })

  it('rejects unknown task-update status with an enum-aware error', async () => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_coord'
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const priorExitCode = process.exitCode

    await main(
      ['orchestration', 'task-update', '--id', 'task_x', '--status', 'complete'],
      '/tmp/repo'
    )

    const output = [...errSpy.mock.calls, ...logSpy.mock.calls]
      .flat()
      .map((v) => (typeof v === 'string' ? v : JSON.stringify(v)))
      .join('\n')
    expect(output).toContain("invalid status 'complete'")
    expect(output).toContain('pending, ready, dispatched, completed, failed, blocked')
    expect(callMock).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(1)

    // Reset exitCode so subsequent tests don't inherit the failure.
    process.exitCode = priorExitCode
    errSpy.mockRestore()
  })

  it('passes the caller terminal handle through orchestration task-create', async () => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_creator'
    callMock.mockResolvedValueOnce({
      id: 'req_task_create',
      ok: true,
      result: {
        task: { id: 'task_1', status: 'ready' }
      },
      _meta: {
        runtimeId: 'runtime-1'
      }
    })
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      [
        'orchestration',
        'task-create',
        '--spec',
        'spawn child workspace',
        '--task-title',
        'Child workspace',
        '--display-name',
        'Spawn child workspace'
      ],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenCalledWith('orchestration.taskCreate', {
      spec: 'spawn child workspace',
      taskTitle: 'Child workspace',
      displayName: 'Spawn child workspace',
      deps: undefined,
      parent: undefined,
      callerTerminalHandle: 'term_creator'
    })
  })

  it('passes dev mode to injected orchestration dispatches', async () => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_sender'
    process.env.ORCA_USER_DATA_PATH = '/tmp/orca-dev'
    callMock.mockResolvedValueOnce({
      id: 'req_dispatch',
      ok: true,
      result: {
        dispatch: { id: 'ctx_1', task_id: 'task_1', status: 'dispatched' }
      },
      _meta: {
        runtimeId: 'runtime-1'
      }
    })
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      ['orchestration', 'dispatch', '--task', 'task_1', '--to', 'term_worker', '--inject'],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenCalledWith('orchestration.dispatch', {
      task: 'task_1',
      to: 'term_worker',
      from: 'term_sender',
      inject: true,
      devMode: true
    })
  })

  it('passes dev mode from an explicit dev CLI marker with a custom profile path', async () => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_sender'
    process.env.ORCA_USER_DATA_PATH = '/tmp/federation-acceptance-profile'
    process.env.ORCA_DEV_CLI_INVOCATION = '1'
    callMock.mockResolvedValueOnce({
      id: 'req_dispatch',
      ok: true,
      result: {
        dispatch: { id: 'ctx_1', task_id: 'task_1', status: 'dispatched' }
      },
      _meta: {
        runtimeId: 'runtime-1'
      }
    })
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      ['orchestration', 'dispatch', '--task', 'task_1', '--to', 'term_worker', '--inject'],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenCalledWith(
      'orchestration.dispatch',
      expect.objectContaining({ devMode: true })
    )
  })
})
