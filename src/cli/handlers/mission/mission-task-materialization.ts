import { RuntimeClientError, type RuntimeClient } from '../../runtime-client'
import type { MissionTask } from './mission-supervisor'

export async function prepareMissionTasks(
  client: RuntimeClient,
  tasks: readonly MissionTask[],
  runId: string,
  from: string
): Promise<void> {
  const taskIdsByKey = await materializeMissionTasks(client, tasks, runId, from)
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

async function materializeMissionTasks(
  client: RuntimeClient,
  tasks: readonly MissionTask[],
  runId: string,
  from: string
): Promise<Map<string, string>> {
  const taskIdsByKey = new Map<string, string>()
  for (const task of orderTasksForCreation(tasks)) {
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

function hasCollaborationIntent(task: MissionTask): boolean {
  return Boolean(
    task.publishesTo?.length ||
    task.requiredPublishesTo?.length ||
    task.subscribesTo?.length ||
    task.admission
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
