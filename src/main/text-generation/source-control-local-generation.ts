import { wslDistroForCommand } from '../../shared/wsl-paths'
import { mergeCommandEnvironment } from '../../shared/command-environment'
import type { CommitMessagePlan } from '../../shared/commit-message-plan'
import {
  resolveCodexHomeProcessLockKeyForSpawnEnv,
  withCodexHomeProcessLock
} from '../codex-cli/codex-home-process-lock'
import { textGenerationFailure } from '../../shared/text-generation-failure-copy'
import {
  clearLocalGenerationCancelToken,
  localGenerationCanceledResult,
  localGenerationLaneKey,
  setLocalGenerationCancelToken
} from './source-control-generation-lanes'
import { SOURCE_CONTROL_GENERATION_TIMEOUT_MS } from './source-control-generation-limits'
import { runLocalSourceControlPlan } from './source-control-local-process'
import type {
  InternalTextGenerationResult,
  LocalGenerationTarget,
  LocalProcessExecution,
  SpawnSourceControlAgent,
  TextGenerationOperation
} from './source-control-text-generation-types'

export function runLocalPlanForAgent(input: {
  agentId: string
  plan: CommitMessagePlan
  target: LocalGenerationTarget
  operation: TextGenerationOperation
  spawnAgent: SpawnSourceControlAgent
  shouldExecute?: () => boolean
}): Promise<InternalTextGenerationResult> {
  const wslDistro = input.plan.promptFile
    ? (wslDistroForCommand(input.target.cwd, input.target.wslDistro) ?? undefined)
    : input.target.wslDistro
  const target = {
    ...input.target,
    wslDistro,
    env: mergeCommandEnvironment(
      input.target.env,
      input.plan.env,
      wslDistro ? 'linux' : process.platform
    )
  }
  const start = (): LocalProcessExecution<InternalTextGenerationResult> => {
    if (
      (input.shouldExecute && !input.shouldExecute()) ||
      input.target.generationRequest?.canceled ||
      (input.target.request && !input.target.request.current())
    ) {
      return {
        result: Promise.resolve(localGenerationCanceledResult()),
        processClosed: Promise.resolve()
      }
    }
    if (input.target.accountAttempt?.spawnAllowed && !input.target.accountAttempt.spawnAllowed()) {
      return {
        result: Promise.resolve({
          success: false,
          subscriptionAccountChanged: true,
          ...textGenerationFailure('generationAccountChanged')
        }),
        processClosed: Promise.resolve()
      }
    }
    if (input.target.request && !input.target.request.claimSpawn()) {
      return {
        result: Promise.resolve({
          success: false,
          ...textGenerationFailure('generationAttemptBudgetEnded')
        }),
        processClosed: Promise.resolve()
      }
    }
    return runLocalSourceControlPlan({
      plan: input.plan,
      cwd: input.target.cwd,
      env: wslDistro ? input.target.env : target.env,
      operation: input.operation,
      wslDistro,
      spawnAgent: input.spawnAgent,
      request: input.target.request,
      generationRequest: input.target.generationRequest,
      timeoutMs: input.target.request
        ? Math.max(1, input.target.request.deadline - Date.now())
        : undefined
    })
  }
  if (input.agentId !== 'codex') {
    const execution = start()
    return input.shouldExecute || input.target.request
      ? execution.result.finally(() => execution.processClosed)
      : execution.result
  }
  return runCodexLocalPlanUnderHomeLock(
    start,
    target,
    input.operation,
    input.plan.env,
    !!input.shouldExecute || !!input.target.request
  )
}

function runCodexLocalPlanUnderHomeLock(
  start: () => LocalProcessExecution<InternalTextGenerationResult>,
  target: LocalGenerationTarget,
  operation: TextGenerationOperation,
  commandEnv?: Record<string, string>,
  awaitSettlement = false
): Promise<InternalTextGenerationResult> {
  const laneKey = localGenerationLaneKey(operation, target.cwd)
  let canceledWhileQueued = false
  let publishResult!: (result: InternalTextGenerationResult) => void
  let rejectResult!: (error: unknown) => void
  let resultPublished = false
  const result = new Promise<InternalTextGenerationResult>((resolve, reject) => {
    publishResult = (value) => {
      if (!resultPublished) {
        resultPublished = true
        resolve(value)
      }
    }
    rejectResult = reject
  })
  let started = false
  const settleQueued = (value: InternalTextGenerationResult): void => {
    if (!started) {
      canceledWhileQueued = true
      publishResult(value)
    }
  }
  const queuedCancel = (): void => settleQueued(localGenerationCanceledResult())
  const request = target.request
  let removeQueuedCancel = (): void => {}
  if (request) {
    // The deadline keeps its timed-out result; Stop reports cancellation.
    const onAbort = (): void =>
      settleQueued(
        request.signal.reason === 'deadline'
          ? {
              success: false,
              ...textGenerationFailure('timedOut', {
                seconds: SOURCE_CONTROL_GENERATION_TIMEOUT_MS / 1000
              })
            }
          : localGenerationCanceledResult()
      )
    request.signal.addEventListener('abort', onAbort, { once: true })
    removeQueuedCancel = () => request.signal.removeEventListener('abort', onAbort)
    if (request.signal.aborted) {
      onAbort()
    }
  } else {
    setLocalGenerationCancelToken(laneKey, queuedCancel, target.generationRequest)
    removeQueuedCancel = () =>
      clearLocalGenerationCancelToken(laneKey, queuedCancel, target.generationRequest)
  }
  const operationSettled = withCodexHomeProcessLock(
    resolveCodexHomeProcessLockKeyForSpawnEnv(target.env, target.wslDistro, commandEnv),
    async () => {
      if (
        canceledWhileQueued ||
        target.generationRequest?.canceled ||
        (request && !request.current())
      ) {
        publishResult(localGenerationCanceledResult())
        return
      }
      if (request && !(await request.validate())) {
        publishResult(localGenerationCanceledResult())
        return
      }
      if (canceledWhileQueued) {
        return
      }
      started = true
      const execution = start()
      try {
        publishResult(await execution.result)
      } catch (error) {
        if (!resultPublished) {
          rejectResult(error)
        }
      } finally {
        await execution.processClosed
      }
    }
  )
    .catch((error: unknown) => {
      if (!resultPublished) {
        rejectResult(error)
      }
    })
    .finally(removeQueuedCancel)
  // A budgeted request settled while queued never spawned; legacy callers keep their lock-bounded admission.
  return awaitSettlement
    ? result.finally(() => (request && canceledWhileQueued ? undefined : operationSettled))
    : result
}

export function runCodexProcessWithHomeLock<T>(
  lockKey: string,
  start: () => LocalProcessExecution<T>
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    void withCodexHomeProcessLock(lockKey, async () => {
      const execution = start()
      try {
        resolve(await execution.result)
      } catch (error) {
        reject(error)
      } finally {
        await execution.processClosed
      }
    }).catch(reject)
  })
}
