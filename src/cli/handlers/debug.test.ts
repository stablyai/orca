import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const callMock = vi.fn()

vi.mock('../runtime-client', () => {
  class RuntimeClient {
    readonly isRemote = false
    call = callMock
    getCliStatus = vi.fn()
    openOrca = vi.fn()
  }

  class RuntimeClientError extends Error {
    readonly code: string

    constructor(code: string, message: string) {
      super(message)
      this.code = code
    }
  }

  class RuntimeRpcFailureError extends RuntimeClientError {
    readonly response: unknown

    constructor(response: unknown) {
      super('runtime_error', 'runtime_error')
      this.response = response
    }
  }

  return { RuntimeClient, RuntimeClientError, RuntimeRpcFailureError }
})

import { main } from '../index'
import { buildWorktree, okFixture, queueFixtures, worktreeListFixture } from '../test-fixtures'
import {
  formatDebugBreakpoints,
  formatDebugConfigs,
  formatDebugEvents,
  formatDebugResult,
  formatDebugStack,
  formatDebugStatus,
  formatDebugVariables,
  formatDebugWait,
  type DebugSnapshot
} from './debug-format'

const WT = ['--worktree', 'id:wt-1']

const SNAPSHOT: DebugSnapshot = {
  seq: 3,
  worktreePath: '/repo',
  status: 'stopped',
  configName: 'Run app',
  adapterId: 'debugpy',
  stopped: { reason: 'breakpoint', threadId: 1, allThreadsStopped: true },
  threads: [{ id: 1, name: 'MainThread' }],
  breakpoints: [],
  lastError: null
}

function ok(value: unknown) {
  return okFixture('req_debug', { ok: true, value })
}

function logged(): string {
  return vi
    .mocked(console.log)
    .mock.calls.map((call) => String(call[0]))
    .join('\n')
}

async function run(args: string[], value: unknown = null): Promise<void> {
  queueFixtures(callMock, ok(value))
  await main(['debug', ...args, ...WT], '/repo')
}

describe('orca debug CLI handlers', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    callMock.mockReset()
    process.exitCode = undefined
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    process.exitCode = undefined
  })

  it.each([
    [['status'], 'debug.status', {}],
    [['configs'], 'debug.configs', {}],
    [['stop'], 'debug.stop', {}],
    [['continue', '--thread', '2'], 'debug.continue', { threadId: 2 }],
    [['pause'], 'debug.pause', {}],
    [['step', '--over'], 'debug.next', {}],
    [['step', '--into', '--thread', '4'], 'debug.stepIn', { threadId: 4 }],
    [['step', '--out'], 'debug.stepOut', {}],
    [['stack', '--thread', '1', '--levels', '5'], 'debug.stack', { threadId: 1, levels: 5 }],
    [
      ['vars', '--frame', '7', '--ref', '9', '--depth', '2'],
      'debug.variables',
      { frameId: 7, variablesReference: 9, depth: 2 }
    ],
    [['eval', 'len(items)'], 'debug.evaluate', { expression: 'len(items)' }],
    [
      ['eval', '--expression', 'x', '--frame', '3'],
      'debug.evaluate',
      { expression: 'x', frameId: 3 }
    ],
    [['events', '--since', '42'], 'debug.events', { since: 42 }],
    [['events'], 'debug.events', { since: 0 }],
    [['break', 'list'], 'debug.breakpoints.list', {}],
    [
      [
        'break',
        'add',
        '--path',
        'src/a.py',
        '--line',
        '10',
        '--condition',
        'n > 1',
        '--hit-condition',
        '3',
        '--log-message',
        'n={n}'
      ],
      'debug.breakpoints.set',
      {
        path: 'src/a.py',
        line: 10,
        condition: 'n > 1',
        hitCondition: '3',
        logMessage: 'n={n}'
      }
    ],
    [
      ['break', 'rm', '--path', 'src/a.py', '--line', '10'],
      'debug.breakpoints.remove',
      {
        path: 'src/a.py',
        line: 10
      }
    ]
  ])('maps %j to its RPC method and params', async (args, method, params) => {
    await run(args, {
      threadId: 1,
      removed: [],
      stackFrames: [],
      variables: [],
      events: []
    })
    expect(callMock).toHaveBeenCalledWith(method, {
      worktree: 'id:wt-1',
      ...params
    })
  })

  it('passes start flags and a 90 s RPC timeout', async () => {
    await run(['start', '--config', 'Run app', '--file', 'src/a.py', '--line', '3'], SNAPSHOT)
    expect(callMock).toHaveBeenCalledWith(
      'debug.start',
      { worktree: 'id:wt-1', config: 'Run app', file: 'src/a.py', line: 3 },
      { timeoutMs: 90_000 }
    )
    expect(logged()).toContain('stopped (breakpoint) on thread 1')
  })

  it('waits with --timeout-ms plus 5 s as the RPC timeout', async () => {
    await run(['wait', '--for', 'either', '--timeout-ms', '20000'], {
      timedOut: false,
      snapshot: SNAPSHOT
    })
    expect(callMock).toHaveBeenCalledWith(
      'debug.wait',
      { worktree: 'id:wt-1', for: 'either', timeoutMs: 20_000 },
      { timeoutMs: 25_000 }
    )
    expect(process.exitCode).toBeUndefined()
  })

  it('defaults wait to --for stopped over 30 s and exits 1 on timeout', async () => {
    await run(['wait'], {
      timedOut: true,
      snapshot: { ...SNAPSHOT, status: 'running', stopped: null }
    })
    expect(callMock).toHaveBeenCalledWith(
      'debug.wait',
      { worktree: 'id:wt-1', for: 'stopped', timeoutMs: 30_000 },
      { timeoutMs: 35_000 }
    )
    expect(logged()).toContain('Timed out; running')
    expect(process.exitCode).toBe(1)
  })

  it.each([
    [['step']],
    [['step', '--over', '--out']],
    [['step', '--over', '1']],
    [['eval']],
    [['wait', '--for', 'paused']],
    [['wait', '--timeout-ms', '200000']],
    [['break', 'add', '--path', 'a.py']],
    [['break', 'rm', '--line', '3']],
    [['vars', '--depth', 'deep']]
  ])('rejects %j without calling the runtime', async (args) => {
    await main(['debug', ...args, ...WT], '/repo')
    expect(callMock).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(1)
  })

  it('rejects eval given both a positional and --expression', async () => {
    await main(['debug', 'eval', 'a', '--expression', 'b', ...WT], '/repo')
    expect(callMock).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(1)
  })

  it('defaults to the worktree containing the current directory', async () => {
    queueFixtures(callMock, worktreeListFixture([buildWorktree('/repo', 'main')]), ok(SNAPSHOT))
    await main(['debug', 'status'], '/repo/src')
    expect(callMock).toHaveBeenLastCalledWith('debug.status', {
      worktree: 'id:repo::/repo'
    })
  })

  it('prints the raw RPC result with --json', async () => {
    queueFixtures(callMock, ok(SNAPSHOT))
    await main(['debug', 'status', '--json', ...WT], '/repo')
    expect(JSON.parse(logged())).toMatchObject({
      ok: true,
      result: { ok: true, value: SNAPSHOT }
    })
  })

  it('prints a refusal and exits 1', async () => {
    const refusal = {
      ok: false,
      reason: 'human-session',
      message: 'A person started this session'
    }
    queueFixtures(callMock, okFixture('req_debug', refusal))
    await main(['debug', 'eval', 'x', ...WT], '/repo')
    expect(logged()).toBe('Refused (human-session): A person started this session')
    expect(process.exitCode).toBe(1)
  })

  it('passes wait --since and prints the control seq a step returns', async () => {
    await run(['wait', '--since', '41', '--timeout-ms', '100'], {
      timedOut: false,
      snapshot: SNAPSHOT
    })
    expect(callMock).toHaveBeenCalledWith(
      'debug.wait',
      { worktree: 'id:wt-1', for: 'stopped', timeoutMs: 100, since: 41 },
      { timeoutMs: 5_100 }
    )
    vi.mocked(console.log).mockClear()
    await run(['continue'], { threadId: 1, controlSeq: 41 })
    expect(logged()).toBe('Continued thread 1. (control seq 41)')
  })

  it('strips terminal control characters from human output but not from --json', async () => {
    const value = {
      result: '\u001b]0;pwned\u0007\u001b[2Jok\r\u009b\ttab\nline',
      variablesReference: 0
    }
    await run(['eval', 'x'], value)
    expect(logged()).toBe(']0;pwned[2Jok\ttab\nline')
    vi.mocked(console.log).mockClear()
    queueFixtures(callMock, ok(value))
    await main(['debug', 'eval', 'x', '--json', ...WT], '/repo')
    expect(JSON.parse(logged()).result.value.result).toBe(value.result)
  })

  it('prints the eval result', async () => {
    await run(['eval', 'n'], {
      result: '42',
      type: 'int',
      variablesReference: 0
    })
    expect(logged()).toBe('42')
  })
})

describe('debug formatters', () => {
  it('formats status as one line', () => {
    const line = formatDebugStatus(SNAPSHOT)
    expect(line).toBe(
      'stopped (breakpoint) on thread 1 · config "Run app" · adapter debugpy · 0 breakpoint(s)'
    )
    expect(
      formatDebugStatus({
        ...SNAPSHOT,
        status: 'idle',
        stopped: null,
        configName: null,
        adapterId: null
      })
    ).toBe('idle · 0 breakpoint(s)')
  })

  it('formats the stack as #n name  path:line', () => {
    const frames = [
      {
        id: 10,
        name: 'handler',
        source: { path: '/repo/a.py' },
        line: 12,
        column: 1
      },
      { id: 11, name: 'main', source: { name: 'b.py' }, line: 3, column: 1 }
    ]
    expect(formatDebugStack({ threadId: 1, stackFrames: frames })).toBe(
      '#0 handler  /repo/a.py:12\n#1 main  b.py:3'
    )
  })

  it('formats variables as an indented tree', () => {
    const variables = [
      {
        name: 'user',
        value: 'User()',
        type: 'User',
        variablesReference: 5,
        children: [{ name: 'id', value: '7', variablesReference: 0 }]
      },
      { name: 'n', value: '1', type: 'int', variablesReference: 0 }
    ]
    expect(
      formatDebugVariables({
        scope: 'Locals',
        variablesReference: 1,
        variables,
        truncated: true
      })
    ).toBe(
      'Locals:\n  user: User = User()\n    id = 7\n  n: int = 1\n(truncated: too many variables; narrow with --ref or a lower --depth)'
    )
  })

  it('prints event output lines, state changes, and latestSeq', () => {
    const page = {
      events: [
        { seq: 1, kind: 'state' as const, status: 'running' },
        { seq: 2, ts: 0, category: 'stdout', text: 'hello\n' }
      ],
      latestSeq: 2,
      truncated: true
    }
    expect(formatDebugEvents(page)).toBe(
      'Some earlier events were evicted; showing what remains.\n[running]\nhello\nlatestSeq: 2'
    )
  })

  it('formats configs, breakpoints, wait and refusals', () => {
    const configs = [
      {
        name: 'Run',
        kind: 'configuration' as const,
        type: 'debugpy',
        request: 'launch',
        runnable: true
      },
      {
        name: 'Both',
        kind: 'compound' as const,
        type: '',
        request: '',
        runnable: false,
        refusal: 'compound'
      }
    ]
    expect(formatDebugConfigs(configs)).toBe(
      'Run  (debugpy launch)\nBoth  (compound)  not runnable: compound'
    )
    const bp = {
      id: 'b',
      path: '/repo/a.py',
      line: 4,
      enabled: true,
      condition: 'x',
      answer: { state: 'verified' as const }
    }
    expect(formatDebugBreakpoints([bp])).toBe('/repo/a.py:4 [verified]  if x')
    const withheld = {
      ...bp,
      author: 'cli' as const,
      answer: { state: 'verified' as const, message: 'agent-written condition withheld' }
    }
    expect(formatDebugBreakpoints([withheld])).toBe(
      '/repo/a.py:4 [verified]  if x  (agent-written condition withheld)'
    )
    const names = { ...bp, path: '/repo/\u001b[31ma.py', condition: undefined }
    expect(formatDebugResult(formatDebugBreakpoints)({ ok: true, value: [names] })).toBe(
      '/repo/[31ma.py:4 [verified]'
    )
    expect(formatDebugBreakpoints([])).toBe('No breakpoints.')
    expect(formatDebugWait({ timedOut: false, snapshot: SNAPSHOT })).toBe(
      formatDebugStatus(SNAPSHOT)
    )
    expect(
      formatDebugResult(String)({
        ok: false,
        reason: 'no-session',
        message: 'none'
      })
    ).toBe('Refused (no-session): none')
  })
})
