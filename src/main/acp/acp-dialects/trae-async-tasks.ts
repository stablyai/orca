import { z } from 'zod'
import type { AcpDialectNotification } from './acp-dialect'
import { acpNotificationEnvelopeSchema } from '../protocol/acp-session-events'

const taskSpawnSchema = z.looseObject({
  sessionUpdate: z.literal('async_task_spawned'),
  asyncTaskId: z.string().min(1),
  name: z.string().optional(),
  taskType: z.string().optional(),
  toolCallId: z.string().nullish()
})
const taskEndSchema = z.looseObject({
  sessionUpdate: z.literal('async_task_state_update'),
  asyncTaskId: z.string().min(1),
  state: z.enum(['completed', 'failed', 'stopped'])
})
const TASK_END_STATES = { completed: 'done', failed: 'blocked', stopped: 'idle' } as const

export function traeAsyncTaskNotification(
  method: string,
  params: unknown,
  at: number
): AcpDialectNotification | undefined {
  if (method !== 'session/update') {
    return undefined
  }
  const envelope = acpNotificationEnvelopeSchema.safeParse(params)
  if (!envelope.success) {
    return undefined
  }
  const spawned = taskSpawnSchema.safeParse(envelope.data.update)
  if (spawned.success) {
    const task = spawned.data
    return {
      disposition: 'map',
      backgroundTasks: [
        {
          taskId: task.asyncTaskId,
          state: 'working',
          kind:
            task.taskType === 'turn' ? 'agent' : task.taskType === 'shell' ? 'command' : 'unknown',
          ...(task.name === undefined ? {} : { label: task.name }),
          ...(task.toolCallId == null ? {} : { parentToolUseId: task.toolCallId }),
          startedAt: at
        }
      ]
    }
  }
  const ended = taskEndSchema.safeParse(envelope.data.update)
  if (!ended.success) {
    return undefined
  }
  return {
    disposition: 'map',
    backgroundTasks: [
      {
        taskId: ended.data.asyncTaskId,
        state: TASK_END_STATES[ended.data.state],
        settledAt: at
      }
    ]
  }
}
