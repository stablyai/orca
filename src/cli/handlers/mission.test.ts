import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HandlerContext } from '../dispatch'
import { RuntimeClientError, type RuntimeClient } from '../runtime-client'
import { MISSION_HANDLERS } from './mission'

type TaskState = {
  id: string
  key: string
  deps: string[]
  status: 'pending' | 'ready' | 'dispatched' | 'completed' | 'failed' | 'blocked'
}

type MissionPlanResult = {
  mission: string
  agent: string
  agentCandidates?: string[]
  plan:
    | { mode: 'single-agent' }
    | {
        mode: 'orchestration'
        objective: string
        maxConcurrency: number
        tasks: {
          key: string
          spec: string
          deps: string[]
          publishesTo?: string[]
          requiredPublishesTo?: string[]
          subscribesTo?: string[]
          admission?: { acceptedTypes: string[]; minPriority: 'normal' | 'high' | 'urgent' }
        }[]
      }
}

function response<T>(result: T) {
  return { id: 'test', ok: true as const, result, _meta: { runtimeId: 'runtime-test' } }
}

function flags(values: Record<string, string | boolean>): Map<string, string | boolean> {
  return new Map(Object.entries(values))
}

function makeContext(
  client: RuntimeClient,
  values: Record<string, string | boolean>
): HandlerContext {
  return {
    client,
    flags: flags(values),
    cwd: '/repo',
    json: false
  }
}

describe('mission start supervisor', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('does not activate or launch Orca before planning a mission from an existing pane', async () => {
    const openOrca = vi.fn()
    const call = vi.fn().mockRejectedValue(new Error('planner_probe'))
    const client = { call, openOrca, isRemote: false } as unknown as RuntimeClient

    await expect(
      MISSION_HANDLERS['mission start'](
        makeContext(client, {
          text: 'inspect routing',
          worktree: 'id:repo::worktree',
          from: 'term_coord'
        })
      )
    ).rejects.toThrow('planner_probe')

    expect(openOrca).not.toHaveBeenCalled()
    expect(call).toHaveBeenCalledWith('mission.plan', {
      text: 'inspect routing',
      worktree: 'id:repo::worktree',
      agent: undefined
    })
  })

  it('falls back to the next mission agent when worker startup fails before task delivery', async () => {
    const task: TaskState = { id: 'task_mission', key: 'mission', deps: [], status: 'ready' }
    let completed = false
    const call = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method === 'mission.plan') {
        return response<MissionPlanResult>({
          mission: 'worker fallback',
          agent: 'pi',
          agentCandidates: ['pi', 'codex'],
          plan: { mode: 'single-agent' }
        })
      }
      if (method === 'orchestration.runCreate') {
        return response({ run: { id: 'run_fallback', objective: 'worker fallback' } })
      }
      if (method === 'orchestration.taskCreate') {
        return response({ task: { id: task.id, status: task.status } })
      }
      if (method === 'orchestration.taskList') {
        task.status = completed ? 'completed' : task.status
        return response({ runId: 'run_fallback', tasks: [task], count: 1 })
      }
      if (method === 'orchestration.workerStart') {
        if (params?.agent === 'pi') {
          task.status = 'failed'
          return response({
            runId: 'run_fallback',
            taskId: task.id,
            dispatchId: 'ctx_pi',
            state: 'failed',
            failedStage: 'agent_readiness',
            lastError: 'Pi could not become ready.'
          })
        }
        if (params?.retryOf !== 'ctx_pi') {
          throw new RuntimeClientError(
            'task_not_startable',
            'Failed Task requires retryOf the latest failed Dispatch.'
          )
        }
        task.status = 'dispatched'
        return response({
          runId: 'run_fallback',
          taskId: task.id,
          dispatchId: 'ctx_codex',
          state: 'ready'
        })
      }
      if (method === 'orchestration.check' && params?.wait) {
        completed = true
        return response({ deliveryId: 'delivery_done', timedOut: false, cancelled: false })
      }
      if (method === 'orchestration.check' && params?.ack) {
        return response({ deliveryId: null, timedOut: false, cancelled: false })
      }
      throw new Error(`unexpected method: ${method}`)
    })
    const client = { call, isRemote: false } as unknown as RuntimeClient
    vi.spyOn(console, 'log').mockImplementation(() => undefined)

    await MISSION_HANDLERS['mission start'](
      makeContext(client, {
        text: 'worker fallback',
        worktree: 'id:repo::worktree',
        from: 'term_coord'
      })
    )

    const workerAgents = call.mock.calls
      .filter(([method]) => method === 'orchestration.workerStart')
      .map(([, params]) => params?.agent)
    expect(workerAgents).toEqual(['pi', 'codex'])
    const workerStarts = call.mock.calls.filter(([method]) => method === 'orchestration.workerStart')
    expect(workerStarts[1]?.[1]).toMatchObject({ retryOf: 'ctx_pi' })
  })

  it('does not retry another agent after an ambiguous dispatch-input failure', async () => {
    const task: TaskState = { id: 'task_mission', key: 'mission', deps: [], status: 'ready' }
    const call = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      void params
      if (method === 'mission.plan') {
        return response<MissionPlanResult>({
          mission: 'unsafe retry guard',
          agent: 'pi',
          agentCandidates: ['pi', 'codex'],
          plan: { mode: 'single-agent' }
        })
      }
      if (method === 'orchestration.runCreate') {
        return response({ run: { id: 'run_guard', objective: 'unsafe retry guard' } })
      }
      if (method === 'orchestration.taskCreate') {
        return response({ task: { id: task.id, status: task.status } })
      }
      if (method === 'orchestration.taskList') {
        return response({ runId: 'run_guard', tasks: [task], count: 1 })
      }
      if (method === 'orchestration.workerStart') {
        return response({
          runId: 'run_guard',
          taskId: task.id,
          dispatchId: 'ctx_pi',
          state: 'failed',
          failedStage: 'dispatch_input',
          lastError: 'Prompt delivery outcome is ambiguous.'
        })
      }
      throw new Error(`unexpected method: ${method}`)
    })
    const client = { call, isRemote: false } as unknown as RuntimeClient

    await expect(
      MISSION_HANDLERS['mission start'](
        makeContext(client, {
          text: 'unsafe retry guard',
          worktree: 'id:repo::worktree',
          from: 'term_coord'
        })
      )
    ).rejects.toMatchObject({ code: 'mission_worker_start_failed' })

    const workerAgents = call.mock.calls
      .filter(([method]) => method === 'orchestration.workerStart')
      .map(([, params]) => params?.agent)
    expect(workerAgents).toEqual(['pi'])
  })

  it('materializes collaboration topology, starts independent workers concurrently, waits by Run mailbox, and acknowledges lifecycle delivery', async () => {
    const tasks = new Map<string, TaskState>()
    const completed = new Set<string>()
    let firstWaitSeen = false
    const call = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method === 'mission.plan') {
        return response<MissionPlanResult>({
          mission: 'parallel mission',
          agent: 'pi',
          plan: {
            mode: 'orchestration',
            objective: 'Parallel mission',
            maxConcurrency: 2,
            tasks: [
              {
                key: 'producer',
                spec: 'Produce findings.',
                deps: [],
                publishesTo: ['/findings'],
                requiredPublishesTo: ['/findings']
              },
              {
                key: 'consumer',
                spec: 'Consume findings.',
                deps: [],
                subscribesTo: ['/findings'],
                admission: { acceptedTypes: ['finding'], minPriority: 'normal' }
              }
            ]
          }
        })
      }
      if (method === 'orchestration.runCreate') {
        return response({ run: { id: 'run_1', objective: 'Parallel mission' } })
      }
      if (method === 'orchestration.taskCreate') {
        const key = String(params?.displayName)
        const id = `task_${key}`
        const deps = JSON.parse(String(params?.deps ?? '[]')) as string[]
        tasks.set(id, { id, key, deps, status: deps.length === 0 ? 'ready' : 'pending' })
        return response({ task: { id, status: tasks.get(id)!.status } })
      }
      if (method === 'orchestration.collaborationConfigure') {
        return response({ runId: 'run_1', stepCount: 2 })
      }
      if (method === 'orchestration.workerStart') {
        const task = tasks.get(String(params?.task))!
        task.status = 'dispatched'
        return response({
          runId: 'run_1',
          taskId: task.id,
          dispatchId: `ctx_${task.key}`,
          state: 'ready',
          effects: [],
          residualResources: []
        })
      }
      if (method === 'orchestration.taskList') {
        for (const task of tasks.values()) {
          if (completed.has(task.id)) {
            task.status = 'completed'
          }
        }
        return response({ runId: 'run_1', tasks: [...tasks.values()], count: tasks.size })
      }
      if (method === 'orchestration.check' && params?.ack) {
        return response({
          runId: 'run_1',
          deliveryId: null,
          messages: [],
          count: 0,
          acknowledged: params.ack,
          timedOut: false,
          cancelled: false,
          connectionLost: false
        })
      }
      if (method === 'orchestration.check' && params?.wait) {
        firstWaitSeen = true
        for (const task of tasks.values()) {
          completed.add(task.id)
        }
        return response({
          runId: 'run_1',
          deliveryId: 'delivery_1',
          messages: [],
          count: 0,
          timedOut: false,
          cancelled: false,
          connectionLost: false
        })
      }
      throw new Error(`unexpected method: ${method}`)
    })
    const client = { call, isRemote: false } as unknown as RuntimeClient
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    await MISSION_HANDLERS['mission start'](
      makeContext(client, {
        text: 'parallel mission',
        worktree: 'id:repo::worktree',
        from: 'term_coord'
      })
    )

    const configure = call.mock.calls.find(
      ([method]) => method === 'orchestration.collaborationConfigure'
    )
    expect(configure?.[1]).toMatchObject({
      run: 'run_1',
      from: 'term_coord',
      steps: [
        {
          taskId: 'task_producer',
          publishesTo: ['/findings'],
          requiredPublishesTo: ['/findings']
        },
        {
          taskId: 'task_consumer',
          subscribesTo: ['/findings'],
          admission: { acceptedTypes: ['finding'], minPriority: 'normal' }
        }
      ]
    })
    const workerCalls = call.mock.calls.filter(([method]) => method === 'orchestration.workerStart')
    expect(workerCalls.map(([, params]) => params?.task)).toEqual([
      'task_producer',
      'task_consumer'
    ])
    expect(firstWaitSeen).toBe(true)
    expect(call).toHaveBeenCalledWith(
      'orchestration.check',
      expect.objectContaining({ ack: 'delivery_1', peek: true })
    )
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Mission run run_1 completed'))
  })

  it('starts one ready wave concurrently up to maxConcurrency', async () => {
    const tasks = new Map<string, TaskState>([
      ['task_a', { id: 'task_a', key: 'a', deps: [], status: 'ready' }],
      ['task_b', { id: 'task_b', key: 'b', deps: [], status: 'ready' }],
      ['task_c', { id: 'task_c', key: 'c', deps: [], status: 'ready' }]
    ])
    let activeStarts = 0
    let maxActiveStarts = 0
    let taskListCount = 0
    const call = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method === 'mission.plan') {
        return response<MissionPlanResult>({
          mission: 'parallel three',
          agent: 'pi',
          plan: {
            mode: 'orchestration',
            objective: 'Parallel three',
            maxConcurrency: 3,
            tasks: [
              { key: 'a', spec: 'A', deps: [] },
              { key: 'b', spec: 'B', deps: [] },
              { key: 'c', spec: 'C', deps: [] }
            ]
          }
        })
      }
      if (method === 'orchestration.runCreate') {
        return response({ run: { id: 'run_parallel', objective: 'Parallel three' } })
      }
      if (method === 'orchestration.taskCreate') {
        const key = String(params?.displayName)
        return response({ task: { id: `task_${key}`, status: 'ready' } })
      }
      if (method === 'orchestration.taskList') {
        taskListCount += 1
        if (taskListCount > 1) {
          for (const task of tasks.values()) {
            task.status = 'completed'
          }
        }
        return response({ runId: 'run_parallel', tasks: [...tasks.values()], count: tasks.size })
      }
      if (method === 'orchestration.workerStart') {
        activeStarts += 1
        maxActiveStarts = Math.max(maxActiveStarts, activeStarts)
        await new Promise((resolve) => setTimeout(resolve, 10))
        activeStarts -= 1
        return response({
          runId: 'run_parallel',
          taskId: String(params?.task),
          dispatchId: `ctx_${String(params?.task)}`,
          state: 'ready',
          effects: [],
          residualResources: []
        })
      }
      throw new Error(`unexpected method: ${method}`)
    })
    const client = { call, isRemote: false } as unknown as RuntimeClient
    vi.spyOn(console, 'log').mockImplementation(() => undefined)

    await MISSION_HANDLERS['mission start'](
      makeContext(client, {
        text: 'parallel three',
        worktree: 'id:repo::worktree',
        from: 'term_coord'
      })
    )

    expect(maxActiveStarts).toBe(3)
  })

  it('waits for capacity before starting a third ready task', async () => {
    const tasks = new Map<string, TaskState>()
    const completed = new Set<string>()
    const events: string[] = []
    let waitCount = 0
    const call = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method === 'mission.plan') {
        return response<MissionPlanResult>({
          mission: 'three-way mission',
          agent: 'pi',
          plan: {
            mode: 'orchestration',
            objective: 'Three-way mission',
            maxConcurrency: 2,
            tasks: [
              { key: 'a', spec: 'A', deps: [] },
              { key: 'b', spec: 'B', deps: [] },
              { key: 'c', spec: 'C', deps: [] }
            ]
          }
        })
      }
      if (method === 'orchestration.runCreate') {
        return response({ run: { id: 'run_3', objective: 'Three-way mission' } })
      }
      if (method === 'orchestration.taskCreate') {
        const key = String(params?.displayName)
        const id = `task_${key}`
        tasks.set(id, { id, key, deps: [], status: 'ready' })
        return response({ task: { id, status: 'ready' } })
      }
      if (method === 'orchestration.workerStart') {
        const task = tasks.get(String(params?.task))!
        events.push(`start:${task.key}`)
        task.status = 'dispatched'
        return response({
          runId: 'run_3',
          taskId: task.id,
          dispatchId: `ctx_${task.key}`,
          state: 'ready',
          effects: [],
          residualResources: []
        })
      }
      if (method === 'orchestration.taskList') {
        for (const task of tasks.values()) {
          if (completed.has(task.id)) {
            task.status = 'completed'
          }
        }
        return response({ runId: 'run_3', tasks: [...tasks.values()], count: tasks.size })
      }
      if (method === 'orchestration.check' && params?.ack) {
        return response({ deliveryId: null, timedOut: false, cancelled: false })
      }
      if (method === 'orchestration.check' && params?.wait) {
        waitCount += 1
        events.push(`wait:${waitCount}`)
        const dispatched = [...tasks.values()].find(
          (task) => task.status === 'dispatched' && !completed.has(task.id)
        )
        if (dispatched) {
          completed.add(dispatched.id)
        }
        return response({
          runId: 'run_3',
          deliveryId: `delivery_${waitCount}`,
          messages: [],
          count: 0,
          timedOut: false,
          cancelled: false,
          connectionLost: false
        })
      }
      throw new Error(`unexpected method: ${method}`)
    })
    const client = { call, isRemote: false } as unknown as RuntimeClient
    vi.spyOn(console, 'log').mockImplementation(() => undefined)

    await MISSION_HANDLERS['mission start'](
      makeContext(client, {
        text: 'three-way mission',
        worktree: 'id:repo::worktree',
        from: 'term_coord'
      })
    )

    expect(events.slice(0, 4)).toEqual(['start:a', 'start:b', 'wait:1', 'start:c'])
  })

  it('creates a reverse-ordered DAG topologically and starts a dependent worker only after its dependency completes', async () => {
    const tasks = new Map<string, TaskState>()
    const completed = new Set<string>()
    let waitCount = 0
    const startOrder: string[] = []
    const createOrder: string[] = []
    const call = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method === 'mission.plan') {
        return response<MissionPlanResult>({
          mission: 'dependency mission',
          agent: 'pi',
          plan: {
            mode: 'orchestration',
            objective: 'Dependency mission',
            maxConcurrency: 2,
            tasks: [
              { key: 'consumer', spec: 'Use producer result.', deps: ['producer'] },
              { key: 'producer', spec: 'Produce result.', deps: [] }
            ]
          }
        })
      }
      if (method === 'orchestration.runCreate') {
        return response({ run: { id: 'run_2', objective: 'Dependency mission' } })
      }
      if (method === 'orchestration.taskCreate') {
        const key = String(params?.displayName)
        createOrder.push(key)
        const id = `task_${key}`
        const deps = JSON.parse(String(params?.deps ?? '[]')) as string[]
        tasks.set(id, { id, key, deps, status: deps.length === 0 ? 'ready' : 'pending' })
        return response({ task: { id, status: tasks.get(id)!.status } })
      }
      if (method === 'orchestration.workerStart') {
        const task = tasks.get(String(params?.task))!
        startOrder.push(task.key)
        task.status = 'dispatched'
        return response({
          runId: 'run_2',
          taskId: task.id,
          dispatchId: `ctx_${task.key}`,
          state: 'ready',
          effects: [],
          residualResources: []
        })
      }
      if (method === 'orchestration.taskList') {
        for (const task of tasks.values()) {
          if (completed.has(task.id)) {
            task.status = 'completed'
          } else if (
            task.status === 'pending' &&
            task.deps.every((dependency) => completed.has(dependency))
          ) {
            task.status = 'ready'
          }
        }
        return response({ runId: 'run_2', tasks: [...tasks.values()], count: tasks.size })
      }
      if (method === 'orchestration.check' && params?.ack) {
        return response({
          runId: 'run_2',
          deliveryId: null,
          messages: [],
          count: 0,
          acknowledged: params.ack,
          timedOut: false,
          cancelled: false,
          connectionLost: false
        })
      }
      if (method === 'orchestration.check' && params?.wait) {
        waitCount += 1
        completed.add(waitCount === 1 ? 'task_producer' : 'task_consumer')
        return response({
          runId: 'run_2',
          deliveryId: `delivery_${waitCount}`,
          messages: [],
          count: 0,
          timedOut: false,
          cancelled: false,
          connectionLost: false
        })
      }
      throw new Error(`unexpected method: ${method}`)
    })
    const client = { call, isRemote: false } as unknown as RuntimeClient
    vi.spyOn(console, 'log').mockImplementation(() => undefined)

    await MISSION_HANDLERS['mission start'](
      makeContext(client, {
        text: 'dependency mission',
        worktree: 'id:repo::worktree',
        from: 'term_coord'
      })
    )

    expect(createOrder).toEqual(['producer', 'consumer'])
    const consumerCreate = call.mock.calls.find(
      ([method, params]) =>
        method === 'orchestration.taskCreate' && params?.displayName === 'consumer'
    )
    expect(JSON.parse(String(consumerCreate?.[1]?.deps))).toEqual(['task_producer'])
    expect(startOrder).toEqual(['producer', 'consumer'])
  })
})
