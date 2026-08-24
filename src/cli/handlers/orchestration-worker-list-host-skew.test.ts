import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_HANDLERS } from './orchestration'

// Why: this suite deliberately leaves ../format unmocked so the assertion covers what a user actually
// sees. The formatter-level test proves the branches; this one proves the handler wires the real
// printResult to them, which is where an old-host response would otherwise slip through untested.
describe('orchestration worker-list across host versions', () => {
  let logged: string[]

  beforeEach(() => {
    logged = []
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      logged.push(String(line))
    })
  })

  afterEach(() => vi.restoreAllMocks())

  const baseWorker = {
    dispatchId: 'ctx_1',
    taskId: 'task_1',
    runId: 'run_1',
    workerState: 'ready',
    dispatchStatus: 'dispatched',
    agentTerminalHandle: 'term_worker',
    terminalState: 'active',
    resource: null
  }

  const runWorkerList = async (result: unknown, json = false) => {
    const call = vi.fn().mockResolvedValue({ id: 'rpc', ok: true, result })
    await ORCHESTRATION_HANDLERS['orchestration worker-list']({
      flags: new Map<string, string | boolean>(),
      client: { call },
      cwd: '/tmp/repo',
      json
    } as never)
    return logged.join('\n')
  }

  it('omits the heartbeat segment entirely against a host that predates the field', async () => {
    const output = await runWorkerList({ workers: [baseWorker], counts: { active: 1 } })

    expect(output).toContain('ctx_1 task=task_1 [ready] terminal=active')
    expect(output).not.toContain('heartbeat=')
  })

  it('reports none, an age, and unknown as three separate answers from a current host', async () => {
    const output = await runWorkerList({
      workers: [
        { ...baseWorker, dispatchId: 'ctx_never', heartbeatState: 'never' },
        {
          ...baseWorker,
          dispatchId: 'ctx_recorded',
          heartbeatState: 'recorded',
          heartbeatAgeSeconds: 7
        },
        { ...baseWorker, dispatchId: 'ctx_unreadable', heartbeatState: 'unreadable' }
      ],
      counts: {}
    })

    expect(output).toContain('ctx_never task=task_1 [ready] terminal=active heartbeat=none')
    expect(output).toContain('ctx_recorded task=task_1 [ready] terminal=active heartbeat=7s')
    expect(output).toContain('ctx_unreadable task=task_1 [ready] terminal=active heartbeat=unknown')
  })

  it('leaves an old host result untouched under --json instead of inventing the fields', async () => {
    const output = await runWorkerList({ workers: [baseWorker], counts: {} }, true)
    const parsed = JSON.parse(output) as {
      result: { workers: Record<string, unknown>[] }
    }

    expect(parsed.result.workers[0]).not.toHaveProperty('heartbeatState')
    expect(parsed.result.workers[0]).not.toHaveProperty('heartbeatAgeSeconds')
    expect(parsed.result.workers[0]).not.toHaveProperty('lastHeartbeatReceivedAt')
  })
})
