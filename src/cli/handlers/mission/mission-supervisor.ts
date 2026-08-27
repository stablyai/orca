import { RuntimeClientError, type RuntimeClient } from '../../runtime-client'
import { isDevCliInvocation } from '../orchestration/runtime-compatibility'

export type MissionAdmission = {
  acceptedTypes: string[]
  minPriority: 'normal' | 'high' | 'urgent'
}

export type MissionTask = {
  key: string
  spec: string
  deps: string[]
  publishesTo?: string[]
  requiredPublishesTo?: string[]
  subscribesTo?: string[]
  admission?: MissionAdmission
}

export type MissionPlan =
  | { mode: 'single-agent' }
  | {
      mode: 'orchestration'
      objective: string
      maxConcurrency: number
      tasks: MissionTask[]
    }

export type MissionPlanRpcResult = {
  mission: string
  agent: string
  plan: MissionPlan
}

export type MissionSummary = {
  mission: string
  runId: string
  agent: string
  state: 'completed' | 'failed'
  completedTasks: number
  failedTasks: number
}

type RuntimeTask = {
  id: string
  status: 'pending' | 'ready' | 'dispatched' | 'completed' | 'failed' | 'blocked'
}

const MISSION_WAIT_TIMEOUT_MS = 600_000

export async function executeMissionRun(input: {
  client: RuntimeClient
  mission: string
  runId: string
  from: string
  worktree: string
  agent: string
  tasks: readonly MissionTask[]
  maxConcurrency: number
}): Promise<MissionSummary> {
  const taskIdsByKey = await materializeMissionTasks(
    input.client,
    input.tasks,
    input.runId,
    input.from
  )
  await configureMissionCollaboration(
    input.client,
    input.tasks,
    taskIdsByKey,
    input.runId,
    input.from
  )
  return superviseMission(input)
}

async function materializeMissionTasks(
  client: RuntimeClient,
  tasks: readonly MissionTask[],
  runId: string,
  from: string
): Promise<Map<string, string>> {
  const ordered = orderTasksForCreation(tasks)
  const taskIdsByKey = new Map<string, string>()
  for (const task of ordered) {
    const deps = task.deps.map((key) => {
      const dependencyId = taskIdsByKey.get(key)
      if (!dependencyId) {
        throw new RuntimeClientError('mission_plan_invalid', `Unknown Mission dependency: ${key}`)
      }
      return dependencyId
    })
    const created = await client.call<{ task: { id: string; status: string } }>(
      'orchestration.taskCreate',
      {
        spec: task.spec,
        taskTitle: task.key,
        displayName: task.key,
        deps: JSON.stringify(deps),
        run: runId,
        callerTerminalHandle: from
      }
    )
    taskIdsByKey.set(task.key, created.result.task.id)
  }
  return taskIdsByKey
}

async function configureMissionCollaboration(
  client: RuntimeClient,
  tasks: readonly MissionTask[],
  taskIdsByKey: ReadonlyMap<string, string>,
  runId: string,
  from: string
): Promise<void> {
  if (!tasks.some(hasCollaborationIntent)) {
    return
  }
  await client.call('orchestration.collaborationConfigure', {
    run: runId,
    from,
    steps: tasks.map((task) => ({
      taskId: taskIdsByKey.get(task.key),
      ...(task.publishesTo ? { publishesTo: task.publishesTo } : {}),
      ...(task.requiredPublishesTo ? { requiredPublishesTo: task.requiredPublishesTo } : {}),
      ...(task.subscribesTo ? { subscribesTo: task.subscribesTo } : {}),
      ...(task.admission ? { admission: task.admission } : {})
    }))
  })
}

function hasCollaborationIntent(task: MissionTask): boolean {
  return Boolean(
    task.publishesTo?.length ||
    task.requiredPublishesTo?.length ||
    task.subscribesTo?.length ||
    task.admission
  )
}

async function superviseMission(input: {
  client: RuntimeClient
  mission: string
  runId: string
  from: string
  worktree: string
  agent: string
  maxConcurrency: number
}): Promise<MissionSummary> {
  const started = new Set<string>()
  for (;;) {
    const listed = await input.client.call<{ tasks: RuntimeTask[]; count: number }>(
      'orchestration.taskList',
      { run: input.runId, callerTerminalHandle: input.from }
    )
    const tasks = listed.result.tasks
    const completed = tasks.filter((task) => task.status === 'completed')
    const failed = tasks.filter((task) => task.status === 'failed')
    if (completed.length + failed.length === tasks.length) {
      return {
        mission: input.mission,
        runId: input.runId,
        agent: input.agent,
        state: failed.length === 0 ? 'completed' : 'failed',
        completedTasks: completed.length,
        failedTasks: failed.length
      }
    }

    let capacity =
      input.maxConcurrency - tasks.filter((task) => task.status === 'dispatched').length
    const ready = tasks.filter((task) => task.status === 'ready' && !started.has(task.id))
    let startedAny = false
    for (const task of ready) {
      if (capacity <= 0) {
        break
      }
      const worker = await input.client.call<{
        taskId: string
        dispatchId: string
        state: string
        lastError?: string
      }>('orchestration.workerStart', {
        task: task.id,
        run: input.runId,
        from: input.from,
        worktree: input.worktree,
        agent: input.agent,
        devMode: isDevCliInvocation()
      })
      if (worker.result.state !== 'ready') {
        throw new RuntimeClientError(
          'mission_worker_start_failed',
          worker.result.lastError ?? `Worker ${worker.result.dispatchId} failed to become ready.`
        )
      }
      started.add(task.id)
      startedAny = true
      capacity -= 1
    }
    if (startedAny) {
      continue
    }

    const active = tasks.some((task) => task.status === 'dispatched')
    if (!active) {
      const blocked = tasks.filter((task) => task.status === 'blocked')
      throw new RuntimeClientError(
        'mission_stalled',
        blocked.length > 0
          ? `Mission stalled with ${blocked.length} blocked task(s).`
          : 'Mission has no active or ready tasks.'
      )
    }

    const waited = await input.client.call<{
      deliveryId: string | null
      timedOut?: boolean
      cancelled?: boolean
      connectionLost?: boolean
    }>('orchestration.check', {
      terminal: input.from,
      run: input.runId,
      wait: true,
      timeoutMs: MISSION_WAIT_TIMEOUT_MS,
      types: 'worker_done,escalation'
    })
    if (waited.result.cancelled) {
      throw new RuntimeClientError(
        'mission_cancelled',
        waited.result.connectionLost
          ? 'Mission coordinator connection closed.'
          : 'Mission wait cancelled.'
      )
    }
    if (waited.result.deliveryId) {
      await input.client.call('orchestration.check', {
        terminal: input.from,
        run: input.runId,
        ack: waited.result.deliveryId,
        peek: true
      })
    }
  }
}

function orderTasksForCreation(tasks: readonly MissionTask[]): MissionTask[] {
  const byKey = new Map(tasks.map((task) => [task.key, task]))
  for (const task of tasks) {
    const missing = task.deps.find((dependency) => !byKey.has(dependency))
    if (missing) {
      throw new RuntimeClientError(
        'mission_plan_invalid',
        `Unknown Mission dependency ${missing} in task ${task.key}.`
      )
    }
  }

  const ordered: MissionTask[] = []
  const emitted = new Set<string>()
  while (ordered.length < tasks.length) {
    const before = ordered.length
    for (const task of tasks) {
      if (emitted.has(task.key) || !task.deps.every((dependency) => emitted.has(dependency))) {
        continue
      }
      emitted.add(task.key)
      ordered.push(task)
    }
    if (ordered.length === before) {
      throw new RuntimeClientError(
        'mission_plan_invalid',
        'Mission task dependency cycle detected.'
      )
    }
  }
  return ordered
}
