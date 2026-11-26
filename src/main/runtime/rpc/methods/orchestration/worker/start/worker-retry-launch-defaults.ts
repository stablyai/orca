import { isTuiAgent } from '../../../../../../../shared/agent-launch/catalog/tui-agent-config'
import type { OrcaRuntimeService } from '../../../../../orca-runtime'
import type { OrchestrationDb } from '../../../../../orchestration/db/orchestration-db'
import {
  parseRecordedWorkerLaunchOptions,
  type RecordedWorkerLaunchOptions
} from './launch/worker-launch-preferences'

type RetryLaunchRuntime = Partial<Pick<OrcaRuntimeService, 'resolveOrchestrationAgentLauncher'>>

/** Rehydrates `--agent`, `--model`, and `--effort` from a retried Dispatch when `--terminal` is absent. */
export function withRetryWorkerLaunchDefaults<
  T extends {
    on?: string
    retryOf?: string
    terminal?: string
    agent?: string
    model?: string
    effort?: string
  }
>(runtime: RetryLaunchRuntime, db: OrchestrationDb, taskId: string | undefined, params: T): T {
  if (!params.retryOf || params.terminal) {
    return params
  }
  const priorContext = db.getDispatchContextById(params.retryOf)
  if (!priorContext || (taskId !== undefined && priorContext.task_id !== taskId)) {
    return params
  }
  const priorWorker = db.getWorkerDispatch(params.retryOf)
  if (!priorWorker) {
    return params
  }
  const prior = parseRecordedWorkerLaunchOptions(priorWorker.start_options)
  const agent = params.agent ?? prior.agent
  const sameAgent = matchesRetriedAgent(runtime, Boolean(params.on), agent, prior)
  const model = params.model ?? (sameAgent ? prior.model : undefined)
  const effort = params.effort ?? (sameAgent ? prior.effort : undefined)
  if (agent === params.agent && model === params.model && effort === params.effort) {
    return params
  }
  return {
    ...params,
    ...(agent !== undefined ? { agent } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(effort !== undefined ? { effort } : {})
  }
}

function matchesRetriedAgent(
  runtime: RetryLaunchRuntime,
  remoteServer: boolean,
  effectiveAgent: string | undefined,
  prior: RecordedWorkerLaunchOptions
): boolean {
  if (!effectiveAgent || !prior.agent) {
    return false
  }
  if (
    effectiveAgent === prior.agent ||
    (prior.requestedAgent !== undefined && effectiveAgent === prior.requestedAgent)
  ) {
    return true
  }
  if (remoteServer) {
    return false
  }
  const resolvedEffective = resolveLauncher(runtime, effectiveAgent)
  const resolvedPrior =
    resolveLauncher(runtime, prior.agent) ??
    (prior.requestedAgent ? resolveLauncher(runtime, prior.requestedAgent) : undefined)
  return resolvedEffective !== undefined && resolvedEffective === resolvedPrior
}

function resolveLauncher(runtime: RetryLaunchRuntime, selector: string): string | undefined {
  if (isTuiAgent(selector)) {
    return selector
  }
  try {
    return runtime.resolveOrchestrationAgentLauncher?.(selector)
  } catch {
    return undefined
  }
}
