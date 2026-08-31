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
  agentCandidates?: string[]
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
  agentCandidates?: readonly string[]
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
  agentCandidates?: readonly string[]
  maxConcurrency: number
}): Promise<MissionSummary> {
  const startAttempted = new Set<string>()
  const startFailures = new Map<string, unknown>()
  for (;;) {
    const listed = await input.client.call<{ tasks: RuntimeTask[]; count: number }>(
      'orchestration.taskList',
      { run: input.runId, callerTerminalHandle: input.from }
    )
    const tasks = listed.result.tasks
    const completed = tasks.filter((task) => task.status === 'completed')
    const failed = tasks.filter((task) => task.status === 'failed')
    const unresolvedStartFailure = getUnresolvedStartFailure(tasks, startFailures)
    if (completed.length + failed.length === tasks.length) {
      if (unresolvedStartFailure) {
        throw unresolvedStartFailure
      }
      return {
        mission: input.mission,
        runId: input.runId,
        agent: input.agent,
        state: failed.length === 0 ? 'completed' : 'failed',
        completedTasks: completed.length,
        failedTasks: failed.length
      }
    }

    const capacity =
      input.maxConcurrency - tasks.filter((task) => task.status === 'dispatched').length
    const wave = tasks
      .filter((task) => task.status === 'ready' && !startAttempted.has(task.id))
      .slice(0, Math.max(0, capacity))
    if (wave.length > 0) {
      const startedWave = await Promise.allSettled(
        wave.map(async (task) => {
          try {
            await startMissionWorker(input, task.id)
          } finally {
            startAttempted.add(task.id)
          }
        })
      )
      for (const [index, result] of startedWave.entries()) {
        if (result.status === 'rejected') {
          startFailures.set(wave[index]!.id, result.reason)
        }
      }
      continue
    }

    const active = tasks.some((task) => task.status === 'dispatched')
    if (!active) {
      if (unresolvedStartFailure) {
        throw unresolvedStartFailure
      }
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

function getUnresolvedStartFailure(
  tasks: readonly RuntimeTask[],
  startFailures: ReadonlyMap<string, unknown>
): unknown {
  for (const [taskId, error] of startFailures) {
    const task = tasks.find((candidate) => candidate.id === taskId)
    if (task?.status !== 'completed') {
      return error
    }
  }
  return null
}

type MissionWorkerStartResult = {
  taskId: string
  dispatchId: string
  state: string
  failedStage?: string
  lastError?: string
}

const RETRYABLE_WORKER_START_STAGES = new Set(['terminal_create', 'agent_readiness'])

async function startMissionWorker(
  input: {
    client: RuntimeClient
    runId: string
    from: string
    worktree: string
    agent: string
    agentCandidates?: readonly string[]
  },
  taskId: string
): Promise<void> {
  const candidates = input.agentCandidates?.length ? input.agentCandidates : [input.agent]
  const failures: string[] = []
  let retryOf: string | undefined

  for (const [index, agent] of candidates.entries()) {
    try {
      const worker = await input.client.call<MissionWorkerStartResult>('orchestration.workerStart', {
        task: taskId,
        run: input.runId,
        from: input.from,
        worktree: input.worktree,
        agent,
        ...(retryOf ? { retryOf } : {}),
        devMode: isDevCliInvocation()
      })
      if (worker.result.state === 'ready') {
        return
      }

      const reason =
        worker.result.lastError ?? `Worker ${worker.result.dispatchId} failed to become ready.`
      const hasNext = index + 1 < candidates.length
      if (hasNext && RETRYABLE_WORKER_START_STAGES.has(worker.result.failedStage ?? '')) {
        failures.push(`${agent}: ${reason}`)
        retryOf = worker.result.dispatchId
        continue
      }
      throw new RuntimeClientError('mission_worker_start_failed', reason)
    } catch (error) {
      const hasNext = index + 1 < candidates.length
      if (hasNext && error instanceof RuntimeClientError && error.code === 'agent_unconfigured') {
        failures.push(`${agent}: ${error.message}`)
        continue
      }
      throw error
    }
  }

  throw new RuntimeClientError(
    'mission_worker_start_failed',
    `No mission agent could start task ${taskId}: ${failures.join('; ')}`
  )
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
