import { prepareCommanderDispatch } from '../commander/prepare-dispatch'
import type { CommandHandler } from '../../dispatch/dispatch'
import { printResult } from '../../output/command-result-output'
import { withReceiptNext } from '../receipt-next-text'
import { getOptionalStringFlag, getPresentStringFlag } from '../../arguments/flags'
import { RuntimeClientError } from '../../runtime/connection/types'
import type { RuntimeClient } from '../../runtime/client'
import type { RuntimeStatus } from '../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import {
  ORCHESTRATION_COMMANDER_DISPATCH_RUNTIME_CAPABILITY,
  ORCHESTRATION_WORKER_LAUNCH_PREFERENCES_RUNTIME_CAPABILITY
} from '../../../shared/orchestration/orchestration-runtime-capabilities'
import { callOrchestrationMutation } from '../recovery/mutation-request'
import { getOptionalPositiveIntegerValueFlag } from '../numeric-flags'
import { isDevCliInvocation } from '../recovery/runtime-compatibility'
import { resolveCoordinatorTerminalHandle } from '../identity/terminal-identity'
import { formatWorkerStart, type WorkerReleaseReceipt } from './worker-output'
import {
  isLiveWorkerStart,
  WORKER_START_VIEW,
  type WorkerStartAgentReceipt
} from './worker-start-agent-view'
import { reconcileWorkerStartTimeout } from './worker-start-timeout'
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
    const task = getOptionalStringFlag(flags, 'task')
    const spec = await readTextOrFileFlag(flags, cwd, 'spec', false)
    const from = await resolveCoordinatorTerminalHandle(flags, cwd, client)
    const modelFlag = getOptionalStringFlag(flags, 'model')
    const effortFlag = getOptionalStringFlag(flags, 'effort')
    let routingHost: string | undefined
    if (modelFlag || effortFlag || flags.has('commander-project')) {
      const { result } = await client.call<RuntimeStatus>('status.get')
      routingHost = JSON.stringify([
        result.hostDescriptor?.installationId ?? result.runtimeId,
        result.pairedDeviceId ?? null
      ])
      const required = flags.has('commander-project')
        ? ORCHESTRATION_COMMANDER_DISPATCH_RUNTIME_CAPABILITY
        : ORCHESTRATION_WORKER_LAUNCH_PREFERENCES_RUNTIME_CAPABILITY
      if (!result.capabilities?.includes(required)) {
        throw new RuntimeClientError(
          'incompatible_runtime',
          'The connected Orca runtime does not support these worker launch preferences. Update or restart Orca and try again.'
        )
      }
    }
    const taskTitle = getOptionalStringFlag(flags, 'task-title')
    const deps = getOptionalStringFlag(flags, 'deps')
    const parent = getOptionalStringFlag(flags, 'parent')
    const item = getOptionalStringFlag(flags, 'item')
    const forQuestion = getOptionalStringFlag(flags, 'for')
    const launchParams = {
      task,
      ...(spec ? { spec } : {}),
      ...(taskTitle ? { taskTitle } : {}),
      ...(deps ? { deps } : {}),
      ...(parent ? { parent } : {}),
      // The host checks the caller is a bot's own chat and the item is open, then records it.
      ...(item ? { origin: `bot-item:${item}` } : {}),
      ...(forQuestion ? { forQuestion } : {}),
      on: getOptionalStringFlag(flags, 'on'),
      worktree: getOptionalStringFlag(flags, 'worktree'),
      name: getOptionalStringFlag(flags, 'name'),
      repo: getOptionalStringFlag(flags, 'repo'),
      baseBranch: getOptionalStringFlag(flags, 'base-branch'),
      displayName: getOptionalStringFlag(flags, 'display-name'),
      comment: getOptionalStringFlag(flags, 'comment'),
      setup: getOptionalStringFlag(flags, 'setup'),
      agent: getOptionalStringFlag(flags, 'agent'),
      model: modelFlag,
      effort: effortFlag,
      terminal,
      retryOf: getOptionalStringFlag(flags, 'retry-of'),
      timeoutMs: getOptionalPositiveIntegerValueFlag(flags, 'timeout-ms'),
      run: getOptionalStringFlag(flags, 'run'),
      from,
      devMode: isDevCliInvocation()
    }
    const routing = await prepareCommanderDispatch(ctx, launchParams, routingHost)
    const result = await callOrchestrationMutation<WorkerStartAgentReceipt>(
      client,
      routing ? new Map(flags).set('retry-request', routing.requestId) : flags,
      'orchestration.workerStart',
      {
        ...launchParams,
        model: routing?.model ?? modelFlag,
        effort: routing?.effort ?? effortFlag,
        ...(routing
          ? {
              commander: {
                projectId: routing.projectId,
                decisionPageId: routing.pageId,
                reason: routing.reason,
                guidelines: routing.guidelines
              }
            }
          : {})
      }
    ).catch(async (error: unknown) => {
      if (!flags.has('retry-request')) {
        const recovered = await reconcileWorkerStartTimeout(client, error)
        if (recovered) {
          return recovered
        }
      }
      throw await explainOlderRuntimeRunRequired(client, error)
    })
    if (result.result.state !== 'ready') {
      process.exitCode = 1
    }
    const keepOpenState =
      (flags.has('keep-open') ||
        (result.result.keepOpenByDefault ?? startsInNewWorkspace(flags))) &&
      isLiveWorkerStart(result.result)
        ? await keepWorkerOpen(client, result.result.dispatchId)
        : undefined
    const renderedResult = {
      ...result,
      result: {
        ...withResolvedNextCommands(result.result),
        ...(routing ? { routingDecision: routing.pageId, routingReason: routing.reason } : {}),
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

// Hosts that predate keepOpenByDefault keep every new-workspace worker open, its chat.
function startsInNewWorkspace(flags: Map<string, string | boolean>): boolean {
  const worktree = getOptionalStringFlag(flags, 'worktree')
  return worktree === 'new-child' || worktree === 'new-top-level'
}

// Every host version serves workerRetain, so older servers keep the worker open too.
export async function keepWorkerOpen(client: RuntimeClient, dispatch: string): Promise<string> {
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
