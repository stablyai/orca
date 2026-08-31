import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HandlerContext } from '../dispatch'
import { RuntimeClientError, type RuntimeClient } from '../runtime-client'
import { MISSION_HANDLERS } from './mission'

type ProbeOptions = {
  active?: string
  failAt?: string
  error?: Error
  closeConfirmed?: boolean
  taskFailed?: boolean
  staleHandle?: boolean
  isRemote?: boolean
  planGate?: Promise<void>
  workerStartFailure?: 'terminal_create' | 'dispatch_input'
  failEarlierCandidate?: boolean
  closeOnSecondAttempt?: boolean
  replacementPty?: boolean
  missingPty?: boolean
  omitStopVerdict?: boolean
}

function fixture(options: ProbeOptions = {}) {
  let taskStatus = 'ready'
  let starts = 0
  let closes = 0
  const events: string[] = []
  const response = <T>(result: T) => ({
    id: 'test',
    ok: true as const,
    result,
    _meta: { runtimeId: 'runtime-test' }
  })
  const call = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    events.push(method)
    if (method === options.failAt) {
      throw options.error ?? new Error('injected failure')
    }
    switch (method) {
      case 'worktree.list':
        return response({ worktrees: [{ id: 'repo::/repo', path: '/repo' }] })
      case 'terminal.resolveActive':
        if (options.active) {
          return response({ handle: options.active })
        }
        throw new RuntimeClientError('no_active_terminal', 'no_active_terminal')
      case 'terminal.show':
        if (options.staleHandle) {
          throw new RuntimeClientError('terminal_gone', 'terminal gone')
        }
        return response({
          terminal: {
            handle: params?.terminal,
            ptyId: options.replacementPty ? 'pty_other' : 'pty_auto'
          }
        })
      case 'terminal.resolvePane':
        return response({ terminal: { handle: 'term_pane' } })
      case 'terminal.create':
        return response({
          terminal: {
            handle: 'term_auto',
            ptyId: options.missingPty ? null : 'pty_auto',
            worktreeId: 'repo::/repo',
            title: 'Mission coordinator'
          }
        })
      case 'terminal.close':
        closes += 1
        return response({
          close: {
            handle: params?.terminal,
            tabId: 'tab_auto',
            ptyKilled: options.closeOnSecondAttempt ? closes > 1 : options.closeConfirmed !== false,
            ...(!options.omitStopVerdict &&
            (options.closeConfirmed === false || (options.closeOnSecondAttempt && closes === 1))
              ? { ptyStopVerdict: 'unverifiable' }
              : {})
          }
        })
      case 'terminal.wait':
        throw new RuntimeClientError('timeout', 'timeout')
      case 'mission.plan':
        await options.planGate
        return response({
          mission: 'echo marker',
          agent: 'omp',
          plan: { mode: 'single-agent' },
          ...(options.failEarlierCandidate ? { agentCandidates: ['omp', 'codex'] } : {})
        })
      case 'orchestration.runCreate':
        return response({ run: { id: 'run_auto', objective: params?.objective } })
      case 'orchestration.taskCreate':
        return response({ task: { id: 'task_auto', status: taskStatus } })
      case 'orchestration.taskList':
        return response({
          runId: 'run_auto',
          tasks: [{ id: 'task_auto', status: taskStatus }],
          count: 1
        })
      case 'orchestration.workerStart':
        starts += 1
        taskStatus = options.taskFailed || options.workerStartFailure ? 'failed' : 'completed'
        return response({
          runId: 'run_auto',
          taskId: 'task_auto',
          dispatchId: 'dispatch_auto',
          state: options.workerStartFailure ? 'failed' : 'ready',
          failedStage:
            options.failEarlierCandidate && starts === 1
              ? 'agent_readiness'
              : options.workerStartFailure,
          effects: [
            { kind: 'worktree', action: 'reused', id: 'repo::/repo' },
            { kind: 'setup', action: 'not_applicable', state: 'not_applicable' }
          ],
          residualResources:
            options.failEarlierCandidate && starts === 1 ? [{ id: 'term_residual' }] : []
        })
      default:
        throw new Error(`unexpected RPC: ${method}`)
    }
  })
  const client = { call, isRemote: options.isRemote ?? false } as unknown as RuntimeClient
  const run = (extra: Record<string, string | boolean> = {}) => {
    const context: HandlerContext = {
      client,
      cwd: '/repo',
      json: true,
      flags: new Map(Object.entries({ text: 'echo marker', ...extra }))
    }
    return MISSION_HANDLERS['mission start'](context)
  }
  return { call, events, run }
}

describe('Mission coordinator ownership', () => {
  let oldExitCode: typeof process.exitCode
  beforeEach(() => {
    oldExitCode = process.exitCode
    vi.stubEnv('ORCA_TERMINAL_HANDLE', undefined)
    vi.stubEnv('ORCA_PANE_KEY', undefined)
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })
  afterEach(() => {
    process.exitCode = oldExitCode
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('runs from an ordinary shell with no existing terminals and closes its own coordinator after completion', async () => {
    const probe = fixture()
    await probe.run()
    expect(probe.call).toHaveBeenCalledWith(
      'terminal.create',
      expect.objectContaining({
        worktree: 'id:repo::/repo',
        focus: false,
        presentation: 'background'
      })
    )
    expect(probe.call).toHaveBeenCalledWith('orchestration.runCreate', {
      objective: 'echo marker',
      from: 'term_auto'
    })
    expect(probe.call).toHaveBeenCalledWith(
      'orchestration.workerStart',
      expect.objectContaining({ from: 'term_auto', worktree: 'id:repo::/repo' })
    )
    expect(probe.call).toHaveBeenCalledWith('terminal.close', { terminal: 'term_auto' })
    expect(probe.events.at(-1)).toBe('terminal.close')
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('"completed"'))
  })

  it('does not borrow an unrelated focused terminal for an external shell', async () => {
    const probe = fixture({ active: 'term_someone_else' })
    await probe.run()
    expect(probe.call).not.toHaveBeenCalledWith('terminal.resolveActive', expect.anything())
    expect(probe.call).toHaveBeenCalledWith(
      'orchestration.runCreate',
      expect.objectContaining({ from: 'term_auto' })
    )
  })

  it.each(['folder:folder-one', 'id:remote-repo::/server/repo'])(
    'creates the coordinator on the explicitly selected workspace %s',
    async (worktree) => {
      const probe = fixture({ isRemote: true })
      await probe.run({ worktree })
      expect(probe.call).toHaveBeenCalledWith(
        'terminal.create',
        expect.objectContaining({ worktree })
      )
      expect(probe.call).not.toHaveBeenCalledWith('worktree.list', expect.anything())
    }
  )

  it('does not create or close a caller-supplied coordinator', async () => {
    const probe = fixture()
    await probe.run({ from: 'term_user' })
    expect(probe.call).toHaveBeenCalledWith(
      'orchestration.runCreate',
      expect.objectContaining({ from: 'term_user' })
    )
    expect(probe.events).not.toContain('terminal.create')
    expect(probe.events).not.toContain('terminal.close')
  })

  it('reuses a verified environment terminal without taking ownership', async () => {
    vi.stubEnv('ORCA_TERMINAL_HANDLE', 'term_environment')
    const probe = fixture()
    await probe.run()
    expect(probe.call).toHaveBeenCalledWith('terminal.show', { terminal: 'term_environment' })
    expect(probe.call).toHaveBeenCalledWith(
      'orchestration.runCreate',
      expect.objectContaining({ from: 'term_environment' })
    )
    expect(probe.events).not.toContain('terminal.close')
  })

  it('resolves a stable pane identity without falling through to window focus', async () => {
    vi.stubEnv('ORCA_PANE_KEY', 'tab_user:leaf_user')
    const probe = fixture({ active: 'term_someone_else' })
    await probe.run()
    expect(probe.call).toHaveBeenCalledWith('terminal.resolvePane', {
      paneKey: 'tab_user:leaf_user'
    })
    expect(probe.call).toHaveBeenCalledWith(
      'orchestration.runCreate',
      expect.objectContaining({ from: 'term_pane' })
    )
    expect(probe.events).not.toContain('terminal.create')
    expect(probe.events).not.toContain('terminal.close')
  })

  it('does not silently replace a stale inherited terminal identity', async () => {
    vi.stubEnv('ORCA_TERMINAL_HANDLE', 'term_old_runtime')
    const probe = fixture({ staleHandle: true })
    await expect(probe.run()).rejects.toMatchObject({ code: 'no_active_sender_terminal' })
    expect(probe.events).not.toContain('terminal.create')
    expect(probe.events).not.toContain('mission.plan')
  })

  it('closes its unused coordinator if planning fails without masking the planner error', async () => {
    const error = new Error('planner failure')
    const probe = fixture({ failAt: 'mission.plan', error })
    await expect(probe.run()).rejects.toBe(error)
    expect(probe.call).toHaveBeenCalledWith('terminal.close', { terminal: 'term_auto' })
    expect(probe.events).not.toContain('orchestration.runCreate')
  })

  it.each(['orchestration.runCreate', 'orchestration.workerStart'])(
    'preserves the coordinator when %s has an unknown outcome',
    async (failAt) => {
      const error = new RuntimeClientError('rpc_timeout', 'reply not received')
      const probe = fixture({ failAt, error })
      await expect(probe.run()).rejects.toBe(error)
      expect(probe.events).not.toContain('terminal.close')
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('term_auto'))
    }
  )

  it('closes its coordinator when all tasks have definitively failed', async () => {
    const probe = fixture({ taskFailed: true })
    await probe.run()
    expect(process.exitCode).toBe(1)
    expect(probe.call).toHaveBeenCalledWith('terminal.close', { terminal: 'term_auto' })
  })

  it.each([
    { closeConfirmed: false },
    {
      failAt: 'terminal.close',
      error: new RuntimeClientError('rpc_timeout', 'close reply missing')
    }
  ])('does not claim clean success when coordinator closure is unverified: %j', async (options) => {
    const probe = fixture(options)
    await probe.run()
    expect(process.exitCode).toBe(1)
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('term_auto'))
    expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/unverif|not confirmed/i))
    if ('failAt' in options) {
      expect(probe.call.mock.calls.filter(([method]) => method === 'terminal.close')).toHaveLength(
        1
      )
    }
  })

  it('does not retry a coordinator create after a lost response', async () => {
    const error = new RuntimeClientError('rpc_timeout', 'create reply missing')
    const probe = fixture({ failAt: 'terminal.create', error })
    await expect(probe.run()).rejects.toBe(error)
    expect(probe.call.mock.calls.filter(([method]) => method === 'terminal.create')).toHaveLength(1)
    expect(probe.events).not.toContain('orchestration.runCreate')
  })

  it.each([false, true])(
    'revalidates before bounded close retry, missing verdict=%s',
    async (omitStopVerdict) => {
      const probe = fixture({ closeOnSecondAttempt: true, omitStopVerdict })
      await probe.run()
      expect(probe.events.slice(-4)).toEqual([
        'terminal.close',
        'terminal.wait',
        'terminal.show',
        'terminal.close'
      ])
      expect(console.error).not.toHaveBeenCalledWith(
        expect.stringContaining('cleanup is unverifiable')
      )
    }
  )

  it('does not retry close if revalidation finds a replacement PTY', async () => {
    const probe = fixture({ closeOnSecondAttempt: true, replacementPty: true })
    await probe.run()
    expect(probe.call.mock.calls.filter(([method]) => method === 'terminal.close')).toHaveLength(1)
    expect(process.exitCode).toBe(1)
  })

  it('does not retry close when the creation receipt had no PTY identity', async () => {
    const probe = fixture({ closeOnSecondAttempt: true, missingPty: true })
    await probe.run()
    expect(probe.call.mock.calls.filter(([method]) => method === 'terminal.close')).toHaveLength(1)
    expect(probe.events).not.toContain('terminal.show')
    expect(process.exitCode).toBe(1)
  })

  it('closes after a definitively no-effect worker startup failure without hiding the error', async () => {
    const probe = fixture({ workerStartFailure: 'terminal_create' })
    await expect(probe.run()).rejects.toMatchObject({ code: 'mission_worker_start_failed' })
    expect(probe.call).toHaveBeenCalledWith('terminal.close', { terminal: 'term_auto' })
  })

  it('retains an ambiguous prompt delivery failure even when task status is failed', async () => {
    const probe = fixture({ workerStartFailure: 'dispatch_input' })
    await expect(probe.run()).rejects.toMatchObject({ code: 'mission_worker_start_failed' })
    expect(probe.events).not.toContain('terminal.close')
  })

  it('does not erase earlier candidate residuals after a final no-effect failure', async () => {
    const probe = fixture({ failEarlierCandidate: true, workerStartFailure: 'terminal_create' })
    await expect(probe.run()).rejects.toMatchObject({ code: 'mission_worker_start_failed' })
    expect(
      probe.call.mock.calls.filter(([method]) => method === 'orchestration.workerStart')
    ).toHaveLength(2)
    expect(probe.events).not.toContain('terminal.close')
  })

  it('cleans its pre-Run anchor on Ctrl+C and prevents the pending plan from creating a Run', async () => {
    let releasePlan!: () => void
    const planGate = new Promise<void>((resolve) => {
      releasePlan = resolve
    })
    const previousListeners = process.listeners('SIGINT')
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    const probe = fixture({ planGate })
    const pending = probe.run()
    const rejected = expect(pending).rejects.toMatchObject({ code: 'mission_cancelled' })
    await vi.waitFor(() => expect(probe.events).toContain('mission.plan'))
    const interrupt = process
      .listeners('SIGINT')
      .find((listener) => !previousListeners.includes(listener))
    try {
      expect(interrupt).toBeTypeOf('function')
      interrupt!('SIGINT')
      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(130))
    } finally {
      releasePlan()
    }
    await rejected
    expect(probe.events).not.toContain('orchestration.runCreate')
    expect(probe.call.mock.calls.filter(([method]) => method === 'terminal.close')).toHaveLength(1)
    expect(process.listeners('SIGINT')).toEqual(previousListeners)
  })
})
