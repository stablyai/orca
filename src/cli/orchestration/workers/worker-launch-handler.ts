import type { CommandHandler } from '../../dispatch/dispatch'
import { printResult } from '../../output/command-result-output'
import { withReceiptNext } from '../receipt-next-text'
import { getOptionalStringFlag, getPresentStringFlag } from '../../arguments/flags'
import { RuntimeClientError } from '../../runtime/types'
import type { RuntimeClient } from '../../runtime/client'
import type { RuntimeStatus } from '../../../shared/runtime-session-contracts'
import { ORCHESTRATION_WORKER_LAUNCH_PREFERENCES_RUNTIME_CAPABILITY } from '../../../shared/orchestration/orchestration-runtime-capabilities'
import { callOrchestrationMutation } from '../recovery/mutation-request'
import { getOptionalPositiveIntegerValueFlag } from '../numeric-flags'
import { isDevCliInvocation } from '../recovery/runtime-compatibility'
import { resolveCoordinatorTerminalHandle } from '../identity/terminal-identity'
import { PROJECT_DEFAULT_AGENT_RUNTIME_CAPABILITY } from '../../../shared/agent-launch/contracts/agent-launch-runtime-capability'
import { formatWorkerStart, type WorkerReleaseReceipt } from './worker-output'
import { isUnobservedTurnStart, WORKER_START_VIEW } from './worker-start-agent-view'
import {
  printOrchestrationResult,
  renderOrchestrationArgv,
  reportOrchestrationFailure
} from '../agent-view'
import { explainOlderRuntimeRunRequired } from '../recovery/older-runtime-run-binding'
import { withResolvedNextCommands } from '../recovery/orchestration-mutation-recovery'
import { readTextOrFileFlag } from '../../arguments/command-body-input'
import { refuseAgentServerRoute } from '../identity/agent-server-route'

export const ORCHESTRATION_WORKER_LAUNCH_HANDLER: Record<string, CommandHandler> = {
  'orchestration worker-start': async (ctx) => {
    const { flags, client, cwd, json } = ctx
    await refuseAgentServerRoute('worker-start', ctx)
    const terminal = getPresentStringFlag(flags, 'terminal')
    const model = getOptionalStringFlag(flags, 'model')
    const effort = getOptionalStringFlag(flags, 'effort')
    const requestedAgent = getOptionalStringFlag(flags, 'agent')
    if (model || effort || requestedAgent === 'default') {
      const status = await client.call<RuntimeStatus>('status.get')
      if (
        requestedAgent === 'default' &&
        !status.result.capabilities?.includes(PROJECT_DEFAULT_AGENT_RUNTIME_CAPABILITY)
      ) {
        throw new RuntimeClientError(
          'incompatible_runtime',
          'The connected Orca runtime does not support project default agents. Update or restart Orca and try again.'
        )
      }
      if (
        (model || effort) &&
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
      agent: requestedAgent,
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
      (flags.has('keep-open') || startsInNewWorkspace(flags)) &&
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
    // Only an explicit --keep-open fails the start; a new workspace's default is best effort.
    if (flags.has('keep-open') && keepOpenState && keepOpenState !== 'retained') {
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

// A worker given its own new workspace is that workspace's chat; closing it frees no space.
function startsInNewWorkspace(flags: Map<string, string | boolean>): boolean {
  const worktree = getOptionalStringFlag(flags, 'worktree')
  return worktree === 'new-child' || worktree === 'new-top-level'
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
