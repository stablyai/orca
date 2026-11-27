import { isTuiAgent } from '../../../../../../../shared/agent-launch/catalog/tui-agent-config'
import { ORCHESTRATION_WORKER_LAUNCH_PREFERENCES_RUNTIME_CAPABILITY } from '../../../../../../../shared/orchestration/orchestration-runtime-capabilities'
import type { OrcaRuntimeService } from '../../../../../orca-runtime'
import type { OrchestrationDb } from '../../../../../orchestration/db/orchestration-db'
import { getRemoteDispatch } from '../../../../../orchestration/db/remote-owned/remote-dispatch-records'
import { OrchestrationError } from '../../../../../orchestration/orchestration-error'
import {
  createPendingWorkerLaunchReceipt,
  formatDroppedRetryLaunchWarning,
  joinWorkerStartWarnings,
  parseRecordedWorkerLaunchOptions,
  resolveFederatedWorkerLaunchPreferences,
  type OrchestrationWorkerLaunchReceipt,
  type RecordedWorkerLaunchOptions
} from './launch/worker-launch-preferences'

type RetryLaunchRuntime = Partial<Pick<OrcaRuntimeService, 'resolveOrchestrationAgentLauncher'>>

const REMOTE_LAUNCH_PREFERENCE_MESSAGE =
  /launch-time model selection|needs a provider\/id model|does not support effort|requested launch preferences|^--effort requires --model\.$/

/** Rehydrates `--agent`, `--model`, and `--effort` from a retried Dispatch when `--terminal` is absent. */
export function withRetryWorkerLaunchDefaults<
  T extends {
    on?: string
    retryOf?: string
    terminal?: string
    agent?: string
    model?: string
    effort?: string
    inheritedLaunchPreferences?: boolean
  }
>(
  runtime: RetryLaunchRuntime,
  db: OrchestrationDb,
  taskId: string | undefined,
  params: T
): T & { inheritedLaunchPreferences?: boolean } {
  if (!params.retryOf || params.terminal) {
    return params
  }
  const priorContext = db.getDispatchContextById(params.retryOf)
  if (!priorContext) {
    const remotePrior = getRemoteDispatch(db, params.retryOf)
    if (!remotePrior || (taskId !== undefined && remotePrior.task_id !== taskId)) {
      return params
    }
    const agent = params.agent ?? remotePrior.agent ?? undefined
    return agent !== undefined && agent !== params.agent ? { ...params, agent } : params
  }
  if (taskId !== undefined && priorContext.task_id !== taskId) {
    return params
  }
  const priorWorker = db.getWorkerDispatch(params.retryOf)
  if (!priorWorker) {
    return params
  }
  const prior = parseRecordedWorkerLaunchOptions(priorWorker.start_options)
  const agent = params.agent ?? prior.agent
  const sameAgent = matchesRetriedAgent(runtime, Boolean(params.on), agent, prior)
  const callerSpecifiedPreferences = params.model !== undefined || params.effort !== undefined
  const inheritPreferences =
    !callerSpecifiedPreferences && sameAgent && Boolean(prior.model || prior.effort)
  if (agent === params.agent && !inheritPreferences) {
    return params
  }
  return {
    ...params,
    ...(agent !== undefined ? { agent } : {}),
    ...(inheritPreferences && prior.model !== undefined ? { model: prior.model } : {}),
    ...(inheritPreferences && prior.effort !== undefined ? { effort: prior.effort } : {}),
    ...(inheritPreferences ? { inheritedLaunchPreferences: true } : {})
  }
}

export async function prepareRemoteOwnedRetryLaunch<
  T extends {
    agent?: string
    model?: string
    effort?: string
    worktree?: string
    inheritedLaunchPreferences?: boolean
  }
>(
  params: T,
  serverName: string,
  supportsLaunchPreferences: () => Promise<boolean>
): Promise<{ params: T; warning?: string }> {
  if (!params.model && !params.effort) {
    return { params }
  }
  const capabilities = (await supportsLaunchPreferences())
    ? [ORCHESTRATION_WORKER_LAUNCH_PREFERENCES_RUNTIME_CAPABILITY]
    : []
  const createsWorktree = params.worktree === 'new-top-level' || params.worktree === 'new-child'
  try {
    const plan = resolveFederatedWorkerLaunchPreferences({
      params,
      createsWorktree,
      capabilities,
      serverName
    })
    return {
      params: { ...params, model: plan.model, effort: plan.effort },
      ...(plan.warning ? { warning: plan.warning } : {})
    }
  } catch (error) {
    if (error instanceof OrchestrationError) {
      throw new OrchestrationError(error.code, error.message, { effectsApplied: false })
    }
    throw error
  }
}

export async function callRemoteStartWithRetryLaunchFallback<T>(args: {
  inherited?: boolean
  model?: string
  effort?: string
  requestedLaunch?: OrchestrationWorkerLaunchReceipt
  warning?: string
  onFallback?: (dropped: {
    warning: string
    requestedLaunch: OrchestrationWorkerLaunchReceipt
  }) => void
  send: (overrides: { model: string | undefined; effort: string | undefined }) => Promise<T>
}): Promise<{
  result: T
  requestedLaunch: OrchestrationWorkerLaunchReceipt
  warning?: string
  droppedWarning?: string
}> {
  const fallbackReceipt = args.requestedLaunch ?? createPendingWorkerLaunchReceipt({ agent: null })
  try {
    return {
      result: await args.send({ model: args.model, effort: args.effort }),
      requestedLaunch: fallbackReceipt,
      warning: args.warning
    }
  } catch (error) {
    if (!args.inherited || (!args.model && !args.effort) || !isRemoteLaunchRefusal(error)) {
      throw error
    }
    const droppedWarning = formatDroppedRetryLaunchWarning(args, error.message)
    const nextLaunch = createPendingWorkerLaunchReceipt({ agent: fallbackReceipt.requested.agent })
    args.onFallback?.({ warning: droppedWarning, requestedLaunch: nextLaunch })
    return {
      result: await args.send({ model: undefined, effort: undefined }),
      requestedLaunch: nextLaunch,
      warning: droppedWarning,
      droppedWarning
    }
  }
}

export function withRemoteStartWarning<T>(answer: T, warning: string | undefined): T {
  if (!warning || !answer || typeof answer !== 'object') {
    return answer
  }
  const existing =
    'warning' in answer && typeof answer.warning === 'string' ? answer.warning : undefined
  const joined = joinWorkerStartWarnings(warning, existing)
  return joined ? { ...answer, warning: joined } : answer
}

function isRemoteLaunchRefusal(error: unknown): error is OrchestrationError {
  if (!(error instanceof OrchestrationError)) {
    return false
  }
  if (
    typeof error.data === 'object' &&
    error.data !== null &&
    'dispatchId' in error.data &&
    typeof error.data.dispatchId === 'string'
  ) {
    return false
  }
  return (
    error.code === 'capability_unsupported' ||
    (error.code === 'invalid_argument' && REMOTE_LAUNCH_PREFERENCE_MESSAGE.test(error.message))
  )
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
