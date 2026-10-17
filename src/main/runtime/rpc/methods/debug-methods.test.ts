import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { DebugServiceError, DebugUnavailableError } from '../../../debug/debug-service-trust'
import type { RpcRequest } from '../core'
import { RpcDispatcher } from '../dispatcher'
import { DEBUG_METHODS } from './debug-methods'

const service = vi.hoisted(() => ({
  snapshot: vi.fn(),
  listConfigs: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  restart: vi.fn(),
  inspect: vi.fn(),
  control: vi.fn(),
  markCliControl: vi.fn(),
  cliControlSeq: vi.fn(),
  listBreakpoints: vi.fn(),
  addBreakpoint: vi.fn(),
  removeBreakpoint: vi.fn(),
  eventsSince: vi.fn(),
  waitFor: vi.fn()
}))

vi.mock('../../../debug/debug-service', async () => {
  const trust = await import('../../../debug/debug-service-trust')
  return { debugService: service, DebugServiceError: trust.DebugServiceError }
})

const ROOT = '/repo/wt'
const TARGET = { repoId: 'repo-1', worktreePath: ROOT }

function makeSession() {
  return {
    threads: vi.fn().mockResolvedValue([{ id: 7, name: 'main' }]),
    stackTrace: vi.fn().mockResolvedValue({ stackFrames: [{ id: 11, name: 'f', line: 1 }] }),
    scopes: vi.fn().mockResolvedValue([
      { name: 'Globals', variablesReference: 1, expensive: false },
      { name: 'Locals', variablesReference: 2, expensive: false }
    ]),
    variables: vi
      .fn()
      .mockImplementation(async (ref: number) =>
        ref === 2
          ? [{ name: 'obj', value: '{}', variablesReference: 3 }]
          : [{ name: 'inner', value: '1', variablesReference: 0 }]
      ),
    evaluate: vi.fn().mockResolvedValue({ result: '42', variablesReference: 0 }),
    continue: vi.fn().mockResolvedValue(undefined),
    next: vi.fn().mockResolvedValue(undefined),
    stepIn: vi.fn().mockResolvedValue(undefined),
    stepOut: vi.fn().mockResolvedValue(undefined),
    pause: vi.fn().mockResolvedValue(undefined)
  }
}

let session: ReturnType<typeof makeSession>
const showManagedWorktree = vi.fn()

function dispatcher(): RpcDispatcher {
  const runtime = {
    getRuntimeId: () => 'test-runtime',
    showManagedWorktree
  } as unknown as OrcaRuntimeService
  return new RpcDispatcher({ runtime, methods: DEBUG_METHODS })
}

async function call(method: string, params: Record<string, unknown>) {
  const request: RpcRequest = { id: 'req', authToken: 'tok', method, params }
  return dispatcher().dispatch(request)
}

async function result(method: string, params: Record<string, unknown>) {
  const response = await call(method, params)
  if (!response.ok) {
    throw new Error(`rpc failed: ${response.error.code} ${response.error.message}`)
  }
  return response.result
}

beforeEach(() => {
  vi.clearAllMocks()
  session = makeSession()
  showManagedWorktree.mockResolvedValue({ id: `repo-1::${ROOT}`, repoId: 'repo-1', path: ROOT })
  service.snapshot.mockResolvedValue({ stopped: { threadId: 7, reason: 'breakpoint' } })
  service.inspect.mockResolvedValue(session)
  service.control.mockResolvedValue(session)
  service.start.mockResolvedValue({ ok: true, value: { status: 'starting' } })
  service.restart.mockResolvedValue({ ok: true, value: { status: 'running' } })
  service.listBreakpoints.mockResolvedValue([])
  service.waitFor.mockResolvedValue({ timedOut: true, snapshot: {} })
  service.markCliControl.mockReturnValue(41)
  service.cliControlSeq.mockResolvedValue(40)
})

describe('debug RPC methods', () => {
  it('resolves the worktree selector to the record repoId and path', async () => {
    await result('debug.status', { worktree: 'branch:feature' })
    expect(showManagedWorktree).toHaveBeenCalledWith('branch:feature')
    expect(service.snapshot).toHaveBeenCalledWith(TARGET)
  })

  it('falls back to the repoId encoded in the worktree id', async () => {
    showManagedWorktree.mockResolvedValue({ id: `repo-2::${ROOT}`, repoId: '', path: ROOT })
    await result('debug.events', { worktree: 'x', since: 5 })
    expect(service.eventsSince).toHaveBeenCalledWith({ repoId: 'repo-2', worktreePath: ROOT }, 5)
  })

  it('always calls the service with origin cli', async () => {
    await result('debug.start', { worktree: 'x', config: 'Run', file: 'src/a.py', line: 3 })
    expect(service.start).toHaveBeenCalledWith({
      ...TARGET,
      configName: 'Run',
      filePath: `${ROOT}/src/a.py`,
      lineNumber: 3,
      expectedHash: undefined,
      origin: 'cli'
    })
    await result('debug.restart', { worktree: 'x' })
    expect(service.restart).toHaveBeenCalledWith(TARGET, 'cli')
    await result('debug.next', { worktree: 'x' })
    await result('debug.evaluate', { worktree: 'x', expression: 'a + b' })
    expect(service.control.mock.calls.every(([, origin]) => origin === 'cli')).toBe(true)
    await result('debug.breakpoints.set', { worktree: 'x', path: 'a.py', line: 2 })
    expect(service.addBreakpoint.mock.calls[0]?.[3]).toBe('cli')
  })

  it('defaults stepping and pause to the stopped thread', async () => {
    expect(await result('debug.pause', { worktree: 'x' })).toEqual({
      ok: true,
      value: { threadId: 7, controlSeq: 41 }
    })
    expect(session.pause).toHaveBeenCalledWith(7)
    await result('debug.stepIn', { worktree: 'x', threadId: 3 })
    expect(session.stepIn).toHaveBeenCalledWith(3)
  })

  it('defaults evaluate to the top frame of the stopped thread', async () => {
    await result('debug.evaluate', { worktree: 'x', expression: 'x' })
    expect(session.stackTrace).toHaveBeenCalledWith(7, 0, 1)
    expect(session.evaluate).toHaveBeenCalledWith('x', 11, 'repl')
  })

  it('defaults variables to the top frame Locals at depth 1', async () => {
    const out = await result('debug.variables', { worktree: 'x' })
    expect(session.scopes).toHaveBeenCalledWith(11)
    expect(session.variables).toHaveBeenCalledTimes(1)
    expect(session.variables).toHaveBeenCalledWith(2)
    expect(out).toMatchObject({
      ok: true,
      value: { frameId: 11, scope: 'Locals', variables: [{ name: 'obj' }] }
    })
  })

  it('expands nested variables up to the requested depth', async () => {
    const out = await result('debug.variables', { worktree: 'x', variablesReference: 2, depth: 2 })
    expect(out).toMatchObject({
      value: { variables: [{ name: 'obj', children: [{ name: 'inner' }] }] }
    })
  })

  it('rejects oversize input before the service is called', async () => {
    const cases: [string, Record<string, unknown>][] = [
      ['debug.evaluate', { worktree: 'x', expression: 'a'.repeat(8 * 1024 + 1) }],
      ['debug.evaluate', { worktree: 'x', expression: 'é'.repeat(4097) }],
      ['debug.stack', { worktree: 'x', levels: 201 }],
      ['debug.variables', { worktree: 'x', depth: 4 }],
      ['debug.wait', { worktree: 'x', for: 'stopped', timeoutMs: 120_001 }],
      ['debug.breakpoints.set', { worktree: 'x', path: 'a', line: 1, condition: 'c'.repeat(9000) }],
      ['debug.status', { worktree: 'w'.repeat(5000) }]
    ]
    for (const [method, params] of cases) {
      const response = await call(method, params)
      expect(response.ok, method).toBe(false)
    }
    expect(showManagedWorktree).not.toHaveBeenCalled()
  })

  it('surfaces a service refusal with its reason', async () => {
    const refusal = { ok: false, reason: 'launch-not-approved', message: 'a person must start it' }
    service.start.mockResolvedValue(refusal)
    expect(await result('debug.start', { worktree: 'x' })).toEqual(refusal)

    service.control.mockRejectedValue(
      new DebugServiceError('human-session', 'agents may only read')
    )
    expect(await result('debug.evaluate', { worktree: 'x', expression: '1' })).toEqual({
      ok: false,
      reason: 'human-session',
      message: 'agents may only read'
    })
    expect(session.evaluate).not.toHaveBeenCalled()
  })

  it('surfaces debug_unavailable from an unconfigured service', async () => {
    service.listConfigs.mockImplementation(() => {
      throw new DebugUnavailableError()
    })
    expect(await result('debug.configs', { worktree: 'x' })).toMatchObject({
      ok: false,
      reason: 'debug_unavailable'
    })
  })

  it('refuses a breakpoint path outside the worktree', async () => {
    const out = await result('debug.breakpoints.set', { worktree: 'x', path: '../etc/a', line: 1 })
    expect(out).toMatchObject({ ok: false, reason: 'outside-worktree' })
    expect(service.addBreakpoint).not.toHaveBeenCalled()
  })

  it('removes a breakpoint by worktree-relative path and line', async () => {
    service.listBreakpoints.mockResolvedValue([{ id: 'b1', path: `${ROOT}/a.py`, line: 4 }])
    const out = await result('debug.breakpoints.remove', { worktree: 'x', path: 'a.py', line: 4 })
    expect(out).toEqual({ ok: true, value: { removed: ['b1'] } })
    expect(service.removeBreakpoint).toHaveBeenCalledWith(TARGET, 'b1', 'cli')
  })

  it('passes the wait timeout through, counting from the last cli control unless since is given', async () => {
    await result('debug.wait', { worktree: 'x', for: 'either', timeoutMs: 1500 })
    const statuses = ['stopped', 'terminated', 'failed']
    expect(service.waitFor).toHaveBeenCalledWith(TARGET, statuses, 1500, 40)
    await result('debug.wait', { worktree: 'x', for: 'either', timeoutMs: 1500, since: 3 })
    expect(service.waitFor).toHaveBeenLastCalledWith(TARGET, statuses, 1500, 3)
    service.cliControlSeq.mockResolvedValue(null)
    await result('debug.wait', { worktree: 'x', for: 'stopped', timeoutMs: 10 })
    expect(service.waitFor).toHaveBeenLastCalledWith(TARGET, ['stopped'], 10, undefined)
  })

  it('stamps the control seq after the thread lookup and before the request, and returns it', async () => {
    for (const step of ['continue', 'next', 'stepIn', 'stepOut', 'pause'] as const) {
      vi.clearAllMocks()
      service.markCliControl.mockReturnValue(41)
      const out = await result(`debug.${step}`, { worktree: 'x' })
      expect(out).toEqual({ ok: true, value: { threadId: 7, controlSeq: 41 } })
      expect(service.markCliControl).toHaveBeenCalledWith(session)
      const marked = service.markCliControl.mock.invocationCallOrder[0]
      expect(marked).toBeGreaterThan(service.snapshot.mock.invocationCallOrder[0])
      expect(marked).toBeLessThan(session[step].mock.invocationCallOrder[0])
    }
    const started = await result('debug.start', { worktree: 'x' })
    expect(started).toEqual({ ok: true, value: { status: 'starting', controlSeq: 40 } })
    const restarted = await result('debug.restart', { worktree: 'x' })
    expect(restarted).toEqual({ ok: true, value: { status: 'running', controlSeq: 40 } })
  })

  it('stops and removes breakpoints as cli, so core can refuse a person’s', async () => {
    service.stop.mockRejectedValue(new DebugServiceError('human-session', 'a person started it'))
    expect(await result('debug.stop', { worktree: 'x' })).toMatchObject({ reason: 'human-session' })
    expect(service.stop).toHaveBeenCalledWith(TARGET, 'cli')
  })

  it('refuses a breakpoint past 1000 in the worktree', async () => {
    service.listBreakpoints.mockResolvedValue(Array.from({ length: 1000 }, (_, i) => ({ id: i })))
    const out = await result('debug.breakpoints.set', { worktree: 'x', path: 'a.py', line: 2 })
    expect(out).toMatchObject({ ok: false, reason: 'too-many-breakpoints' })
    expect(service.addBreakpoint).not.toHaveBeenCalled()
    service.listBreakpoints.mockResolvedValue(Array.from({ length: 999 }, (_, i) => ({ id: i })))
    await result('debug.breakpoints.set', { worktree: 'x', path: 'a.py', line: 2 })
    expect(service.addBreakpoint).toHaveBeenCalledTimes(1)
  })

  it('truncates variable values and eval results over 64 KiB', async () => {
    const huge = 'v'.repeat(70 * 1024)
    session.variables.mockResolvedValue([{ name: 'big', value: huge, variablesReference: 0 }])
    const vars = Object(await result('debug.variables', { worktree: 'x' })).value.variables
    expect(vars[0].value).toHaveLength(64 * 1024)
    expect(vars[0].truncated).toBe(true)
    session.evaluate.mockResolvedValue({ result: huge, variablesReference: 0 })
    const evaluated = Object(await result('debug.evaluate', { worktree: 'x', expression: 'big' }))
    expect(evaluated.value.result).toHaveLength(64 * 1024)
    expect(evaluated.value.truncated).toBe(true)
    session.evaluate.mockResolvedValue({ result: 'small', variablesReference: 0 })
    const small = await result('debug.evaluate', { worktree: 'x', expression: 'small' })
    expect(small).toEqual({ ok: true, value: { result: 'small', variablesReference: 0 } })
  })

  it('declares every debug method with the workspace permission, and exactly these methods', () => {
    expect(DEBUG_METHODS.map((m) => m.name).sort()).toEqual(
      [
        'debug.breakpoints.list',
        'debug.breakpoints.remove',
        'debug.breakpoints.set',
        'debug.configs',
        'debug.continue',
        'debug.evaluate',
        'debug.events',
        'debug.next',
        'debug.pause',
        'debug.restart',
        'debug.stack',
        'debug.start',
        'debug.status',
        'debug.stepIn',
        'debug.stepOut',
        'debug.stop',
        'debug.variables',
        'debug.wait'
      ].sort()
    )
    for (const method of DEBUG_METHODS) {
      expect(method.permission, method.name).toBe('workspace')
    }
  })

  it('exposes no approve method', () => {
    expect(DEBUG_METHODS.map((m) => m.name).filter((name) => /approve/i.test(name))).toEqual([])
  })
})
