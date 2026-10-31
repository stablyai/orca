import type { CommandHandler } from '../../dispatch'
import { printResult } from '../../format'
import { withReceiptNext } from './receipt-next-text'
import { getOptionalStringFlag, getPresentStringFlag } from '../../flags'
import { RuntimeClientError, type RuntimeClient } from '../../runtime-client'
import type { RuntimeStatus } from '../../../shared/runtime-types'
import { ORCHESTRATION_WORKER_LAUNCH_PREFERENCES_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import { callOrchestrationMutation } from './mutation-request'
import { getOptionalPositiveIntegerValueFlag } from './numeric-flags'
import { isDevCliInvocation } from './runtime-compatibility'
import { resolveCoordinatorTerminalHandle } from './terminal-identity'
import { formatWorkerStart, type WorkerReleaseReceipt } from './worker-output'
import { isUnobservedTurnStart, WORKER_START_VIEW } from './worker-start-agent-view'
import {
  printOrchestrationResult,
  renderOrchestrationArgv,
  reportOrchestrationFailure
} from './agent-view'
import { explainOlderRuntimeRunRequired } from './older-runtime-run-binding'
import { withResolvedNextCommands } from '../../orchestration-mutation-recovery'
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
    const result = await callOrchestrationMutation<{
      runId: string
      taskId: string
      dispatchId: string
      state: string
      failedStage?: string
      lastError?: string
      warning?: string
      mode?: { mode: string; preferred: string; reason: string; detail: string }
      effects: unknown[]
      residualResources: unknown[]
      nextCommands?: string[]
      next?: string
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
      terminal,
      retryOf: getOptionalStringFlag(flags, 'retry-of'),
      timeoutMs: getOptionalPositiveIntegerValueFlag(flags, 'timeout-ms'),
      run: getOptionalStringFlag(flags, 'run'),
      from: await resolveCoordinatorTerminalHandle(flags, cwd, client),
      devMode: isDevCliInvocation()
    }).catch(async (error: unknown) => {
      throw await explainOlderRuntimeRunRequired(client, error)
    })
    if (result.result.state !== 'ready') {
      process.exitCode = 1
    }
    const keepOpenState =
      flags.has('keep-open') &&
      (result.result.state === 'ready' || isUnobservedTurnStart(result.result))
        ? await keepWorkerOpen(client, result.result.dispatchId)
        : undefined
    const renderedResult = {
      ...result,
      result: {
        ...withResolvedNextCommands(result.result),
        ...(keepOpenState === 'retained' ? { keptOpen: true as const } : {})
      }
    }
    if (flags.has('full')) {
      printResult(renderedResult, json, (value) =>
        withReceiptNext(
          `${formatWorkerStart(value)}${value.keptOpen ? '\nKept open after it finishes' : ''}`,
          value
        )
      )
    } else {
      printOrchestrationResult(renderedResult, json, WORKER_START_VIEW)
    }
    if (keepOpenState && keepOpenState !== 'retained') {
      const dispatchId = result.result.dispatchId
      // The worker runs either way, so the next step never starts it again.
      const verb =
        keepOpenState === 'already_released'
          ? 'worker-read'
          : keepOpenState.startsWith('release_') || keepOpenState === 'no_owned_resource'
            ? 'worker-show'
            : 'worker-keep-open'
      reportOrchestrationFailure({
        code: 'not_kept_open',
        message: `${dispatchId} started but was not kept open (${keepOpenState}). Run ${renderOrchestrationArgv(['orchestration', verb, '--dispatch', dispatchId])}.`
      })
    }
  }
}

// Every host version serves workerRetain, so older servers keep the worker open too.
async function keepWorkerOpen(client: RuntimeClient, dispatch: string): Promise<string> {
  try {
    const { result } = await client.call<WorkerReleaseReceipt>('orchestration.workerRetain', {
      dispatch
    })
    // A retained receipt without an owned terminal kept nothing open.
    return result.reason === 'no_owned_resource' ? result.reason : result.state
  } catch (error) {
    return error instanceof RuntimeClientError ? error.code : 'keep_open_failed'
  }
}
