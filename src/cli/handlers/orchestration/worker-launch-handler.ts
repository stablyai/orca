import type { CommandHandler } from '../../dispatch'
import { getOptionalStringFlag, getPresentStringFlag } from '../../flags'
import { RuntimeClientError, type RuntimeClient } from '../../runtime-client'
import type { RuntimeStatus } from '../../../shared/runtime-types'
import { ORCHESTRATION_WORKER_LAUNCH_PREFERENCES_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import { callOrchestrationMutation } from './mutation-request'
import { getOptionalPositiveIntegerValueFlag } from './numeric-flags'
import { isDevCliInvocation } from './runtime-compatibility'
import { resolveCoordinatorTerminalHandle } from './terminal-identity'
import {
  isUnobservedTurnStart,
  WORKER_START_VIEW,
  type WorkerStartAgentReceipt
} from './worker-start-agent-view'
import { printOrchestrationResult } from './agent-view'
import { explainOlderRuntimeRunRequired } from './older-runtime-run-binding'
import { renderResolvedOrchestrationCommand } from '../../orchestration-mutation-recovery'
import { readTextOrFileFlag } from '../../command-body-input'

export const ORCHESTRATION_WORKER_LAUNCH_HANDLER: Record<string, CommandHandler> = {
  'orchestration worker-start': async ({ flags, client, cwd, json }) => {
    const terminal = getPresentStringFlag(flags, 'terminal')
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
    const spec = await readTextOrFileFlag(flags, cwd, 'spec', false)
    const taskTitle = getOptionalStringFlag(flags, 'task-title')
    const deps = getOptionalStringFlag(flags, 'deps')
    const parent = getOptionalStringFlag(flags, 'parent')
    const result = await callOrchestrationMutation<WorkerStartAgentReceipt>(
      client,
      flags,
      'orchestration.workerStart',
      {
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
        terminal,
        retryOf: getOptionalStringFlag(flags, 'retry-of'),
        timeoutMs: getOptionalPositiveIntegerValueFlag(flags, 'timeout-ms'),
        run: getOptionalStringFlag(flags, 'run'),
        from: await resolveCoordinatorTerminalHandle(flags, cwd, client),
        devMode: isDevCliInvocation()
      }
    ).catch(async (error: unknown) => {
      throw await explainOlderRuntimeRunRequired(client, error)
    })
    const keptOpen = flags.has('keep-open') && (await keepStartedWorkerOpen(client, result.result))
    const renderedResult = {
      ...result,
      result: {
        ...result.result,
        ...(keptOpen ? { keptOpen } : {}),
        ...(result.result.nextCommands
          ? {
              nextCommands: result.result.nextCommands.map((command) =>
                renderResolvedOrchestrationCommand(command)
              )
            }
          : {})
      }
    }
    printOrchestrationResult(renderedResult, { flags, json }, WORKER_START_VIEW)
  }
}

// Every host version serves workerRetain, so older servers keep the worker open too.
async function keepStartedWorkerOpen(
  client: RuntimeClient,
  receipt: WorkerStartAgentReceipt
): Promise<boolean> {
  if (receipt.state !== 'ready' && !isUnobservedTurnStart(receipt)) {
    return false
  }
  try {
    await client.call('orchestration.workerRetain', { dispatch: receipt.dispatchId })
    return true
  } catch (error) {
    const code = error instanceof RuntimeClientError ? error.code : 'keep_open_failed'
    const message = error instanceof Error ? error.message : String(error)
    // The worker is running, so recovery is the keep-open call, never a second start.
    throw new RuntimeClientError(
      code,
      `Started ${receipt.dispatchId} but could not keep it open: ${message} Run orca orchestration worker-keep-open --dispatch ${receipt.dispatchId}.`
    )
  }
}
