import type { CommandHandler } from '../../dispatch'
import { printResult } from '../../format'
import { getOptionalStringFlag } from '../../flags'
import { RuntimeClientError } from '../../runtime-client'
import type { RuntimeStatus } from '../../../shared/runtime-types'
import { ORCHESTRATION_WORKER_LAUNCH_PREFERENCES_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import { callOrchestrationMutation } from './mutation-request'
import { getOptionalPositiveIntegerValueFlag } from './numeric-flags'
import { isDevCliInvocation } from './runtime-compatibility'
import { resolveCoordinatorTerminalHandle } from './terminal-identity'
import { formatWorkerStart } from './worker-output'
import { renderResolvedOrchestrationCommand } from '../../orchestration-mutation-recovery'

export const ORCHESTRATION_WORKER_LAUNCH_HANDLER: Record<string, CommandHandler> = {
  'orchestration worker-start': async ({ flags, client, cwd, json }) => {
    const model = getOptionalStringFlag(flags, 'model')
    const effort = getOptionalStringFlag(flags, 'effort')
    if (model || effort) {
      const status = await client.call<RuntimeStatus>('status.get')
      if (
        !status.result.capabilities?.includes(
          ORCHESTRATION_WORKER_LAUNCH_PREFERENCES_RUNTIME_CAPABILITY
        )
      ) {
        throw new RuntimeClientError(
          'incompatible_runtime',
          'The connected Orca runtime does not support worker model or effort overrides. Update or restart Orca and try again.'
        )
      }
    }
    const task = getOptionalStringFlag(flags, 'task')
    const spec = getOptionalStringFlag(flags, 'spec')
    const taskTitle = getOptionalStringFlag(flags, 'task-title')
    const deps = getOptionalStringFlag(flags, 'deps')
    const parent = getOptionalStringFlag(flags, 'parent')
    const result = await callOrchestrationMutation<{
      runId: string
      taskId: string
      dispatchId: string
      state: string
      failedStage?: string
      lastError?: string
      warning?: string
      effects: unknown[]
      residualResources: unknown[]
      nextCommands?: string[]
    }>(client, flags, 'orchestration.workerStart', {
      task,
      ...(spec ? { spec } : {}),
      ...(taskTitle ? { taskTitle } : {}),
      ...(deps ? { deps } : {}),
      ...(parent ? { parent } : {}),
      on: getOptionalStringFlag(flags, 'on'),
      worktree: getOptionalStringFlag(flags, 'worktree'),
      name: getOptionalStringFlag(flags, 'name'),
      repo: getOptionalStringFlag(flags, 'repo'),
      baseBranch: getOptionalStringFlag(flags, 'base-branch'),
      displayName: getOptionalStringFlag(flags, 'display-name'),
      comment: getOptionalStringFlag(flags, 'comment'),
      setup: getOptionalStringFlag(flags, 'setup'),
      agent: getOptionalStringFlag(flags, 'agent'),
      model,
      effort,
      terminal: getOptionalStringFlag(flags, 'terminal'),
      retryOf: getOptionalStringFlag(flags, 'retry-of'),
      timeoutMs: getOptionalPositiveIntegerValueFlag(flags, 'timeout-ms'),
      run: getOptionalStringFlag(flags, 'run'),
      from: await resolveCoordinatorTerminalHandle(flags, cwd, client),
      devMode: isDevCliInvocation()
    })
    if (result.result.state !== 'ready') {
      process.exitCode = 1
    }
    const renderedResult = result.result.nextCommands
      ? {
          ...result,
          result: {
            ...result.result,
            nextCommands: result.result.nextCommands.map((command) =>
              renderResolvedOrchestrationCommand(command)
            )
          }
        }
      : result
    printResult(renderedResult, json, formatWorkerStart)
  }
}
