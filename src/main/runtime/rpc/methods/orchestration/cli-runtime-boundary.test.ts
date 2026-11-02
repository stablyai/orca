import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcContext } from '../../core'
import { createOrchestrationRpcHarness } from './rpc-test-harness'
import type { OrchestrationDb } from '../../../orchestration/db'

type CliRuntimeClient = {
  isRemote?: boolean
  call: <T>(method: string, params?: unknown, options?: unknown) => Promise<{ result: T }>
}

type CliHandler = (ctx: {
  flags: Map<string, string | boolean>
  client: CliRuntimeClient
  cwd: string
  json: boolean
}) => Promise<void>

const originalTerminalHandle = process.env.ORCA_TERMINAL_HANDLE

describe('orchestration CLI/runtime boundary', () => {
  const h = createOrchestrationRpcHarness()
  const { findMethod } = h
  let db: OrchestrationDb
  let ctx: RpcContext

  afterEach(() => {
    h.cleanup()
    restoreTerminalHandle()
    vi.doUnmock('../../../../../cli/format')
    vi.doUnmock('../../../../../cli/runtime-client')
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    vi.resetModules()
  })

  /** Bridges CLI client calls into the in-memory RPC harness without bypassing RPC param parsing. */
  async function callRpc(name: string, params: Record<string, unknown>) {
    const method = findMethod(name)
    const parsed = method.params ? method.params.parse(params) : undefined
    return method.handler(parsed, ctx)
  }

  function client(): CliRuntimeClient {
    return {
      isRemote: false,
      /** Preserves terminal-handle validation while routing other calls through runtime RPC. */
      async call<T>(method: string, params?: unknown): Promise<{ result: T }> {
        if (method === 'terminal.resolveIdentity') {
          return {
            result: { identity: { handle: objectParams(params).terminal, live: true } } as T
          }
        }
        return { result: (await callRpc(method, objectParams(params))) as T }
      }
    }
  }

  it('creates and gates a PowerShell-stripped dependency through CLI and runtime', async () => {
    ;({ db, ctx } = h.setup())
    process.env.ORCA_TERMINAL_HANDLE = 'term_coord'
    const handlers = await loadOrchestrationHandlers()
    const runtimeClient = client()

    await runCli(handlers['orchestration task-create'], runtimeClient, [['spec', 'parent work']])
    const parent = taskBySpec('parent work')

    await runCli(handlers['orchestration task-create'], runtimeClient, [
      ['spec', 'child work'],
      ['deps', `[${parent.id}]`]
    ])
    const child = taskBySpec('child work')

    expect(child.status).toBe('pending')
    expect(child.deps).toBe(JSON.stringify([parent.id]))
    await expect(
      runCli(handlers['orchestration dispatch'], runtimeClient, [
        ['task', child.id],
        ['to', 'term_worker']
      ])
    ).rejects.toThrow('only ready tasks can be dispatched')

    await runCli(handlers['orchestration task-update'], runtimeClient, [
      ['id', parent.id],
      ['status', 'completed']
    ])
    expect(db.getTask(child.id)?.status).toBe('ready')

    await runCli(handlers['orchestration dispatch'], runtimeClient, [
      ['task', child.id],
      ['to', 'term_worker']
    ])
    expect(db.getTask(child.id)?.status).toBe('dispatched')
    expect(db.getDispatchContext(child.id)?.assignee_handle).toBe('term_worker')
  })

  it('CLI argv preserves worker commands', async () => {
    ;({ db, ctx } = h.setup())
    const { runtime } = ctx
    process.env.ORCA_TERMINAL_HANDLE = 'term_coord'
    vi.stubEnv('ORCA_PAIRING_CODE', '')
    vi.stubEnv('ORCA_ENVIRONMENT', '')
    vi.stubEnv('ORCA_AGENT_SESSION_ID', '')
    vi.doMock('../../../../../cli/runtime-client', async (importOriginal) => ({
      ...(await importOriginal<Record<string, unknown>>()),
      RuntimeClient: client
    }))
    const output = vi.fn()
    vi.doMock('../../../../../cli/format', () => ({ printResult: output }))
    vi.spyOn(runtime, 'getOrchestrationDispatchAuthority').mockImplementation((handle) =>
      handle === 'term_worker'
        ? {
            runtimeId: runtime.getRuntimeId(),
            terminalHandle: handle,
            ptyId: 'pty_worker',
            worktreeId: 'wt_worker',
            paneKey: 'tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            processIncarnation: 'worker:1',
            launchTokenHash: null,
            hostScope: { kind: 'local', hostId: 'local' }
          }
        : null
    )
    vi.spyOn(runtime, 'isTerminalRunningAgent').mockResolvedValue(true)
    const delivered = vi
      .spyOn(runtime, 'sendTerminalAgentPrompt')
      .mockResolvedValue({ handle: 'term_worker', accepted: true, bytesWritten: 1 })
    const task = db.createTask({ spec: 'complete work and report the outcome' })
    const cliPath = '../../../../../cli/index'
    const { main }: { main(argv: string[]): Promise<void> } = await import(cliPath)
    await main([
      'orchestration',
      'dispatch',
      '--task',
      task.id,
      '--to',
      'term_worker',
      '--inject',
      '--return-preamble',
      '--json',
      '--full'
    ])
    expect(output).toHaveBeenCalledOnce()
    const result = output.mock.calls[0][0].result
    expect(result.injected).toBe(true)
    expect(db.getTask(task.id)?.status).toBe('dispatched')
    expect(delivered).toHaveBeenCalledExactlyOnceWith(
      'term_worker',
      result.preamble,
      expect.anything()
    )
    for (const command of [
      '--type worker_done',
      '--outcome succeeded',
      '--outcome failed',
      'orchestration ask --from',
      '--type escalation'
    ]) {
      expect(result.preamble).toContain(command)
    }
  })

  function taskBySpec(spec: string) {
    const task = db.listTasks().find((candidate) => candidate.spec === spec)
    if (!task) {
      throw new Error(`Expected task with spec: ${spec}`)
    }
    return task
  }
})

/** Imports orchestration handlers after mocking output so the test observes state, not stdout. */
async function loadOrchestrationHandlers(): Promise<Record<string, CliHandler>> {
  vi.doMock('../../../../../cli/format', () => ({ printResult: vi.fn() }))
  const cliModulePath = '../../../../../cli/handlers/orchestration'
  const module = (await import(cliModulePath)) as {
    ORCHESTRATION_HANDLERS: Record<string, CliHandler>
  }
  return module.ORCHESTRATION_HANDLERS
}

async function runCli(
  handler: CliHandler,
  client: CliRuntimeClient,
  entries: [string, string | boolean][]
): Promise<void> {
  await handler({
    flags: new Map<string, string | boolean>(entries),
    client,
    cwd: process.cwd(),
    json: true
  })
}

/** Narrows optional RPC params into the object shape expected by the RPC parser. */
function objectParams(params: unknown): Record<string, unknown> {
  return params && typeof params === 'object' ? (params as Record<string, unknown>) : {}
}

/** Restores the caller terminal environment so later CLI tests do not inherit this fixture. */
function restoreTerminalHandle(): void {
  if (originalTerminalHandle === undefined) {
    delete process.env.ORCA_TERMINAL_HANDLE
  } else {
    process.env.ORCA_TERMINAL_HANDLE = originalTerminalHandle
  }
}
