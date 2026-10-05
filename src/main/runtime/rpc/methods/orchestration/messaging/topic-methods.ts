import { defineMethod } from '../../../core'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { parseTopicList } from '../../../../orchestration/topic-protocol'
import { resolveRunScope } from '../runs/run-scope'
import { TopicSetParams, TopicShowParams } from '../schemas'

function parsePolicyTopics(value: string): string[] {
  try {
    return parseTopicList(value)
  } catch (error) {
    throw new OrchestrationError(
      'invalid_argument',
      error instanceof Error ? error.message : 'Invalid topic list.'
    )
  }
}

export const ORCHESTRATION_TOPIC_METHODS = [
  defineMethod({
    name: 'orchestration.topicSet',
    params: TopicSetParams,
    handler: (
      params,
      { orchestrationCompatibilityEvidence, orchestrationCaller, runtime, legacyCoordinatorRunId }
    ) => {
      const db = runtime.getOrchestrationDb()
      const run = resolveRunScope(runtime, {
        runId: params.run,
        callerTerminalHandle: params.callerTerminalHandle,
        requireCurrentConsumer: true,
        legacyCoordinatorRunId,
        callerEvidence: orchestrationCompatibilityEvidence,
        callerSession: orchestrationCaller
      })
      const task = db.getTask(params.task)
      if (!task || task.run_id !== run.id) {
        throw new OrchestrationError(
          'task_not_found',
          `Task ${params.task} was not found in Run ${run.id}.`
        )
      }

      const policy = db.setTaskTopicPolicy({
        taskId: task.id,
        runId: run.id,
        publishes: parsePolicyTopics(params.publishes),
        subscribes: parsePolicyTopics(params.subscribes)
      })
      return { policy }
    }
  }),
  defineMethod({
    name: 'orchestration.topicShow',
    params: TopicShowParams,
    handler: (
      params,
      { orchestrationCompatibilityEvidence, orchestrationCaller, runtime, legacyCoordinatorRunId }
    ) => {
      const db = runtime.getOrchestrationDb()
      const run = resolveRunScope(runtime, {
        runId: params.run,
        callerTerminalHandle: params.callerTerminalHandle,
        requireCurrentConsumer: true,
        legacyCoordinatorRunId,
        callerEvidence: orchestrationCompatibilityEvidence,
        callerSession: orchestrationCaller
      })
      const task = db.getTask(params.task)
      if (!task || task.run_id !== run.id) {
        throw new OrchestrationError(
          'task_not_found',
          `Task ${params.task} was not found in Run ${run.id}.`
        )
      }

      return {
        policy: db.getTaskTopicPolicy(task.id) ?? {
          taskId: task.id,
          runId: run.id,
          publishes: [],
          subscribes: []
        }
      }
    }
  })
]
