import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from '../../orchestration/db'
import { ORCHESTRATION_GATE_METHODS } from './orchestration-gates'

type MockCoordinatorInstance = {
  resolveRun?: () => void
  stopped: boolean
}

const coordinatorMock = vi.hoisted(() => {
  const instances: MockCoordinatorInstance[] = []

  class Coordinator {
    resolveRun?: () => void
    stopped = false

    constructor() {
      instances.push(this)
    }

    runFromExistingRun(): Promise<unknown> {
      return new Promise((resolve) => {
        this.resolveRun = () => {
          resolve({})
        }
      })
    }

    stop(): void {
      this.stopped = true
      this.resolveRun?.()
    }
  }

  return { Coordinator, instances }
})

vi.mock('../../orchestration/coordinator', () => ({
  Coordinator: coordinatorMock.Coordinator
}))

describe('orchestration gate RPC lifecycle recovery', () => {
  let db: OrchestrationDb | undefined

  afterEach(async () => {
    for (const instance of coordinatorMock.instances) {
      instance.resolveRun?.()
    }
    coordinatorMock.instances.length = 0
    // Why: flush microtasks so the handler's `.finally()` callback can clear
    // the module-scoped active coordinator before the next test starts.
    await Promise.resolve()
    await Promise.resolve()
    db?.close()
    db = undefined
  })

  function findMethod(name: string) {
    const method = ORCHESTRATION_GATE_METHODS.find((candidate) => candidate.name === name)
    if (!method) {
      throw new Error(`Method not found: ${name}`)
    }
    return method
  }

  async function call(name: string, params: Record<string, unknown>): Promise<unknown> {
    const method = findMethod(name)
    const parsed = method.params ? method.params.parse(params) : undefined
    return method.handler(parsed, {
      runtime: { getOrchestrationDb: () => db }
    } as never)
  }

  it('marks a stale durable run failed when stop has no live coordinator', async () => {
    db = new OrchestrationDb(':memory:')
    const staleRun = db.createCoordinatorRun({
      spec: 'old work',
      coordinatorHandle: 'coordinator'
    })

    await expect(call('orchestration.runStop', {})).resolves.toEqual({
      runId: staleRun.id,
      stopped: true
    })

    expect(db.getCoordinatorRun(staleRun.id)?.status).toBe('failed')
    expect(db.getActiveCoordinatorRun()).toBeUndefined()
    expect(coordinatorMock.instances).toHaveLength(0)
  })

  it('fails a stale durable run before accepting a new coordinator run', async () => {
    db = new OrchestrationDb(':memory:')
    const staleRun = db.createCoordinatorRun({
      spec: 'old work',
      coordinatorHandle: 'coordinator'
    })

    const result = (await call('orchestration.run', { spec: 'new work' })) as {
      runId: string
      status: string
    }

    expect(result.status).toBe('running')
    expect(result.runId).not.toBe(staleRun.id)
    expect(db.getCoordinatorRun(staleRun.id)?.status).toBe('failed')
    expect(db.getActiveCoordinatorRun()?.id).toBe(result.runId)
    expect(coordinatorMock.instances).toHaveLength(1)
  })

  it('rejects a new run while a live coordinator is active', async () => {
    db = new OrchestrationDb(':memory:')

    const result = (await call('orchestration.run', { spec: 'active work' })) as {
      runId: string
      status: string
    }

    expect(result.status).toBe('running')
    expect(db.getActiveCoordinatorRun()?.id).toBe(result.runId)
    expect(coordinatorMock.instances).toHaveLength(1)

    await expect(call('orchestration.run', { spec: 'new work' })).rejects.toThrow(
      `Coordinator already running: ${result.runId}`
    )
    expect(db.getActiveCoordinatorRun()?.id).toBe(result.runId)
    expect(coordinatorMock.instances).toHaveLength(1)
  })
})
