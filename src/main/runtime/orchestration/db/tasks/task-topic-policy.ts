import type { OrchestrationDb } from '../orchestration-db'

type TaskTopicPolicyStorageRow = {
  task_id: string
  run_id: string
  publishes: string
  subscribes: string
}

export type TaskTopicPolicy = {
  taskId: string
  runId: string
  publishes: string[]
  subscribes: string[]
}

function exposePolicy(row: TaskTopicPolicyStorageRow): TaskTopicPolicy {
  return {
    taskId: row.task_id,
    runId: row.run_id,
    publishes: JSON.parse(row.publishes),
    subscribes: JSON.parse(row.subscribes)
  }
}

export function setTaskTopicPolicy(
  this: OrchestrationDb,
  policy: TaskTopicPolicy
): TaskTopicPolicy {
  const task = this.getTask(policy.taskId)
  if (!task || task.run_id !== policy.runId) {
    throw new Error(`Task ${policy.taskId} must belong to run ${policy.runId}`)
  }

  this.db
    .prepare(
      `INSERT INTO task_topic_policies (task_id, run_id, publishes, subscribes, updated_at)
       VALUES (?, ?, ?, ?, datetime('now'))
       ON CONFLICT(task_id) DO UPDATE SET
         run_id = excluded.run_id,
         publishes = excluded.publishes,
         subscribes = excluded.subscribes,
         updated_at = datetime('now')`
    )
    .run(
      policy.taskId,
      policy.runId,
      JSON.stringify(policy.publishes),
      JSON.stringify(policy.subscribes)
    )

  return policy
}

export function getTaskTopicPolicy(
  this: OrchestrationDb,
  taskId: string
): TaskTopicPolicy | undefined {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the projection exactly matches task_topic_policies.
  const row = this.db
    .prepare(
      'SELECT task_id, run_id, publishes, subscribes FROM task_topic_policies WHERE task_id = ?'
    )
    .get(taskId) as TaskTopicPolicyStorageRow | undefined
  return row ? exposePolicy(row) : undefined
}

export function taskPublishesTopic(this: OrchestrationDb, taskId: string, topic: string): boolean {
  const row = this.db
    .prepare(
      `SELECT 1 AS allowed
       FROM task_topic_policies
       WHERE task_id = ?
         AND EXISTS (SELECT 1 FROM json_each(publishes) WHERE value = ?)
       LIMIT 1`
    )
    .get(taskId, topic)
  return row !== undefined
}

export function listTopicSubscriberTaskIds(
  this: OrchestrationDb,
  runId: string,
  topic: string
): string[] {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the query projects one TEXT task_id column.
  const rows = this.db
    .prepare(
      `SELECT policy.task_id
       FROM task_topic_policies policy
       JOIN tasks task ON task.id = policy.task_id
       WHERE policy.run_id = ?
         AND EXISTS (SELECT 1 FROM json_each(policy.subscribes) WHERE value = ?)
       ORDER BY task.created_at, policy.task_id`
    )
    .all(runId, topic) as { task_id: string }[]
  return rows.map((row) => row.task_id)
}

export type TaskTopicPolicyMethods = {
  setTaskTopicPolicy: typeof setTaskTopicPolicy
  getTaskTopicPolicy: typeof getTaskTopicPolicy
  taskPublishesTopic: typeof taskPublishesTopic
  listTopicSubscriberTaskIds: typeof listTopicSubscriberTaskIds
}

export function attachTaskTopicPolicy(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    setTaskTopicPolicy,
    getTaskTopicPolicy,
    taskPublishesTopic,
    listTopicSubscriberTaskIds
  })
}
