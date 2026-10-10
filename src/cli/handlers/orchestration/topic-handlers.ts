import type { CommandHandler } from '../../dispatch'
import { printResult } from '../../format'
import { getOptionalStringFlag, getRequiredStringFlag } from '../../flags'
import { callOrchestrationMutation } from './mutation-request'
import { resolveCoordinatorTerminalHandle } from './terminal-identity'

type TopicPolicy = {
  taskId: string
  runId: string
  publishes: string[]
  subscribes: string[]
}

export const ORCHESTRATION_TOPIC_HANDLERS: Record<string, CommandHandler> = {
  'orchestration topic-set': async ({ flags, client, cwd, json }) => {
    const callerTerminalHandle = await resolveCoordinatorTerminalHandle(flags, cwd, client)
    const result = await callOrchestrationMutation<{ policy: TopicPolicy }>(
      client,
      flags,
      'orchestration.topicSet',
      {
        task: getRequiredStringFlag(flags, 'task'),
        publishes: getRequiredStringFlag(flags, 'publishes'),
        subscribes: getRequiredStringFlag(flags, 'subscribes'),
        run: getOptionalStringFlag(flags, 'run'),
        callerTerminalHandle
      }
    )
    printResult(
      result,
      json,
      (value) =>
        `Updated topic policy for ${value.policy.taskId}: publishes [${value.policy.publishes.join(', ')}], subscribes [${value.policy.subscribes.join(', ')}]`
    )
  },

  'orchestration topic-show': async ({ flags, client, cwd, json }) => {
    const result = await client.call<{ policy: TopicPolicy }>('orchestration.topicShow', {
      task: getRequiredStringFlag(flags, 'task'),
      run: getOptionalStringFlag(flags, 'run'),
      callerTerminalHandle: await resolveCoordinatorTerminalHandle(flags, cwd, client)
    })
    printResult(
      result,
      json,
      (value) =>
        `${value.policy.taskId}: publishes [${value.policy.publishes.join(', ')}], subscribes [${value.policy.subscribes.join(', ')}]`
    )
  }
}
