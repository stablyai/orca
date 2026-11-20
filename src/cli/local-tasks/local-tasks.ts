import {
  computeLocalTaskReadiness,
  pickReadyLocalTasks,
  type LocalTaskReadiness
} from '../../shared/local-tasks/local-task-scheduling'
import type { LocalTask, LocalTaskListResult } from '../../shared/local-tasks/local-task-types'
import type { CommandHandler, HandlerContext } from '../dispatch/dispatch'
import {
  getOptionalNumberFlag,
  getOptionalPositiveIntegerFlag,
  getOptionalStringFlag,
  getRepeatedStringFlag,
  getRequiredStringFlag
} from '../arguments/flags'
import { RuntimeClientError } from '../runtime/connection/types'
import { printResult } from '../output/command-result-output'

type LocalTaskRow = LocalTask & { readiness: LocalTaskReadiness }

const describeReadiness = (r: LocalTaskReadiness): string =>
  r.state === 'waiting'
    ? `waiting on ${r.on.join(',')}`
    : r.state === 'claimed'
      ? `claimed by ${r.by}`
      : r.state === 'flagged'
        ? `flagged: ${r.reason}`
        : r.state

const formatRow = (t: LocalTask, readiness: LocalTaskReadiness): string =>
  `${t.id}\t${t.status}\t${describeReadiness(readiness)}\tp${t.priority}\t${t.title}`

const formatTask = (t: LocalTask): string =>
  [
    `${t.id}\t${t.title}`,
    `Status: ${t.status}\tPriority: p${t.priority}`,
    ...(t.claimedBy ? [`Claimed by: ${t.claimedBy} at ${t.claimedAt ?? 'unknown'}`] : []),
    ...(t.dependsOn.length ? [`Depends on: ${t.dependsOn.join(', ')}`] : []),
    ...(t.blockedReason ? [`Blocked: ${t.blockedReason}`] : []),
    ...(t.labels.length ? [`Labels: ${t.labels.join(', ')}`] : []),
    `File: ${t.filePath}`
  ].join('\n')

async function listRows(context: HandlerContext) {
  const response = await context.client.call<LocalTaskListResult>('localTasks.list')
  const readiness = computeLocalTaskReadiness(response.result.tasks)
  const rows: LocalTaskRow[] = response.result.tasks.map((task, i) => ({
    ...task,
    readiness: readiness[i]
  }))
  return { response, rows }
}

const idParam = (context: HandlerContext): string => getRequiredStringFlag(context.flags, 'id')

// Claim-style commands share one shape: task id plus the acting agent name.
const holderCall =
  (method: string, verb: string): CommandHandler =>
  async (context) => {
    const response = await context.client.call<LocalTask>(method, {
      id: idParam(context),
      claimer: getRequiredStringFlag(context.flags, 'as')
    })
    printResult(response, context.json, (t) => `${verb} ${t.id} (${t.status})`)
  }

function editFields(context: HandlerContext) {
  const labels = getRepeatedStringFlag(context.flags, 'label')
  const dependsOn = getRepeatedStringFlag(context.flags, 'depends-on')
  return {
    title: getOptionalStringFlag(context.flags, 'title'),
    status: getOptionalStringFlag(context.flags, 'status'),
    priority: getOptionalNumberFlag(context.flags, 'priority'),
    labels: labels.length ? labels : undefined,
    dependsOn: dependsOn.length ? dependsOn : undefined
  }
}

export const LOCAL_TASKS_HANDLERS: Record<string, CommandHandler> = {
  'local-tasks list': async (context) => {
    const { response, rows } = await listRows(context)
    printResult(
      { ...response, result: { ...response.result, tasks: rows } },
      context.json,
      (r) => r.tasks.map((t) => formatRow(t, t.readiness)).join('\n') || 'No tasks.'
    )
  },
  'local-tasks get': async (context) => {
    const id = idParam(context)
    const { response, rows } = await listRows(context)
    const row = rows.find((t) => t.id === id)
    if (!row) {
      throw new RuntimeClientError('not_found', `Task not found: ${id}`)
    }
    printResult(
      { ...response, result: row },
      context.json,
      (t) => `${formatTask(t)}\nReadiness: ${describeReadiness(t.readiness)}`
    )
  },
  'local-tasks next': async (context) => {
    const slots = getOptionalPositiveIntegerFlag(context.flags, 'slots') ?? 1
    const { response } = await listRows(context)
    const picked = pickReadyLocalTasks(response.result.tasks, slots)
    printResult(
      { ...response, result: { tasks: picked } },
      context.json,
      (r) =>
        r.tasks.map((t) => `${t.id}\tp${t.priority}\t${t.title}`).join('\n') || 'No ready tasks.'
    )
  },
  'local-tasks claim': holderCall('localTasks.claim', 'Claimed'),
  'local-tasks renew': holderCall('localTasks.renew', 'Renewed'),
  'local-tasks release': holderCall('localTasks.release', 'Released'),
  'local-tasks create': async (context) => {
    const response = await context.client.call<LocalTask>('localTasks.create', {
      ...editFields(context),
      title: getRequiredStringFlag(context.flags, 'title'),
      id: getOptionalStringFlag(context.flags, 'id'),
      body: getOptionalStringFlag(context.flags, 'body')
    })
    printResult(response, context.json, (t) => `Created ${t.id}`)
  },
  'local-tasks update': async (context) => {
    const patch = {
      ...editFields(context),
      blockedReason: getOptionalStringFlag(context.flags, 'blocked-reason'),
      url: getOptionalStringFlag(context.flags, 'url')
    }
    const response = await context.client.call<LocalTask>('localTasks.update', {
      id: idParam(context),
      patch
    })
    printResult(response, context.json, (t) => `Updated ${t.id} (${t.status})`)
  }
}
