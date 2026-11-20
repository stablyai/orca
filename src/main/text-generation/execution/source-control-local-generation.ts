import type { GenerationArgument } from '../../../shared/source-control/ai/generation/generation-argument'
import { wslDistroForCommand } from '../../../shared/file-access/wsl-paths'
import { mergeCommandEnvironment } from '../../../shared/shell/launch/command-environment'
import type { CommitMessagePlan } from '../../../shared/source-control/ai/generation/commit-message-plan'
import {
  resolveCodexHomeProcessLockKeyForSpawnEnv,
  withCodexHomeProcessLock
} from '../../codex-cli/codex-home-process-lock'
import { admitUnderFreeCodexHome } from './codex-home-generation-admission'
import {
  CANCELED_GENERATION_RESULT,
  clearLocalGenerationCancelToken,
  localGenerationLaneKey,
  setLocalGenerationCancelToken
} from './source-control-generation-lanes'
import { runLocalSourceControlPlan } from './source-control-local-process'
import { prepareSourceControlReadOnlyPlan } from '../policies/source-control-read-only-policy'
import { SOURCE_CONTROL_GENERATION_TIMEOUT_MS } from './source-control-generation-limits'
import type { GenerationAdmission } from './background-generation-slots'
import { textGenerationFailure } from '../../../shared/text-generation/text-generation-failure-copy'
import type {
  InternalTextGenerationResult,
  LocalGenerationTarget,
  LocalProcessExecution,
  SpawnSourceControlAgent,
  TextGenerationOperation
} from '../source-control-text-generation-types'

export function runLocalPlanForAgent(input: {
  agentId: string
  plan: CommitMessagePlan<GenerationArgument>
  target: LocalGenerationTarget
  operation: TextGenerationOperation
  spawnAgent: SpawnSourceControlAgent
  shouldExecute?: () => boolean
  /** How long the agent may run; the source-control default when absent. */
  timeoutMs?: number
  /** Background naming's shared slot; entered after the Codex home lock. */
  admit?: GenerationAdmission
}): Promise<InternalTextGenerationResult> {
  const needsPolicy = ['codex', 'kimi', 'dsh', 'antigravity', 'amp', 'muse'].includes(input.agentId)
  const wslDistro =
    input.plan.promptFile || input.plan.taskFiles?.length || needsPolicy
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
  const totalTimeoutMs = input.timeoutMs ?? SOURCE_CONTROL_GENERATION_TIMEOUT_MS
  const launch = (plan: CommitMessagePlan<GenerationArgument>, timeoutMs?: number) =>
    runLocalSourceControlPlan({
      plan,
      cwd: input.target.cwd,
      env: wslDistro ? input.target.env : target.env,
      operation: input.operation,
      laneId: input.target.laneId,
      wslDistro,
      spawnAgent: input.spawnAgent,
      timeoutMs: timeoutMs ?? input.timeoutMs
    })
  const prepare = (): LocalProcessExecution<InternalTextGenerationResult> => {
    const result = Promise.withResolvers<InternalTextGenerationResult>()
    const canceled = new AbortController()
    const deadlineAt = Date.now() + totalTimeoutMs
    const deadline = AbortSignal.timeout(totalTimeoutMs)
    const signal = AbortSignal.any([canceled.signal, deadline])
    const lane = localGenerationLaneKey(input.operation, input.target.cwd, input.target.laneId)
    const failure = (): InternalTextGenerationResult =>
      canceled.signal.aborted || input.shouldExecute?.() === false
        ? { success: false, error: 'Generation canceled.', canceled: true }
        : {
            success: false,
            ...(deadline.aborted
              ? textGenerationFailure('timedOut', {
                  seconds: totalTimeoutMs / 1000
                })
              : textGenerationFailure('agentCouldNotStart', { label: input.plan.label }))
          }
    const abort = () => result.resolve(failure())
    const cancel = () => canceled.abort()
    setLocalGenerationCancelToken(lane, cancel)
    signal.addEventListener('abort', abort, { once: true })
    let preparation: LocalProcessExecution<CommitMessagePlan<GenerationArgument>> | undefined
    let execution: LocalProcessExecution<InternalTextGenerationResult> | undefined
    const processClosed = (async () => {
      try {
        if (input.shouldExecute?.() === false) {
          canceled.abort()
        }
        signal.throwIfAborted()
        preparation = prepareSourceControlReadOnlyPlan({ ...input, target, signal })
        const plan = await preparation.result
        await preparation.processClosed
        signal.throwIfAborted()
        if (input.shouldExecute?.() === false) {
          canceled.abort()
          signal.throwIfAborted()
        }
        signal.removeEventListener('abort', abort)
        execution = launch(plan, Math.max(1, deadlineAt - Date.now()))
        result.resolve(await execution.result)
      } catch {
        result.resolve(failure())
      } finally {
        signal.removeEventListener('abort', abort)
        clearLocalGenerationCancelToken(lane, cancel)
        await preparation?.processClosed
        await execution?.processClosed
      }
    })()
    return { result: result.promise, processClosed }
  }
  const start = ():
    | LocalProcessExecution<InternalTextGenerationResult>
    | Promise<LocalProcessExecution<InternalTextGenerationResult>> => {
    if (needsPolicy) {
      return prepare()
    }
    return input.shouldExecute?.() === false
      ? {
          result: Promise.resolve({
            success: false,
            error: 'Generation canceled.',
            canceled: true
          }),
          processClosed: Promise.resolve()
        }
      : launch(input.plan)
  }
  const admit = input.admit
  const finish = (execution: LocalProcessExecution<InternalTextGenerationResult> | null) =>
    !execution
      ? Promise.resolve(CANCELED_GENERATION_RESULT)
      : input.shouldExecute
        ? execution.result.finally(() => execution.processClosed)
        : execution.result
  if (input.agentId !== 'codex') {
    return Promise.resolve(admit ? admit(start) : start()).then(finish)
  }
  if (admit) {
    const lockKey = resolveCodexHomeProcessLockKeyForSpawnEnv(
      target.env,
      target.wslDistro,
      input.plan.env
    )
    return admitUnderFreeCodexHome(admit, lockKey, () =>
      startCodexUnderHomeLock(start, target, input.operation, input.plan.env)
    ).then(finish)
  }
  return runCodexLocalPlanUnderHomeLock(
    start,
    target,
    input.operation,
    input.plan.env,
    !!input.shouldExecute
  )
}

function runCodexLocalPlanUnderHomeLock(
  start: () =>
    | LocalProcessExecution<InternalTextGenerationResult>
    | Promise<LocalProcessExecution<InternalTextGenerationResult>>,
  target: LocalGenerationTarget,
  operation: TextGenerationOperation,
  commandEnv?: Record<string, string>,
  awaitSettlement = false
): Promise<InternalTextGenerationResult> {
  const execution = startCodexUnderHomeLock(start, target, operation, commandEnv)
  return awaitSettlement
    ? execution.result.finally(() => execution.processClosed)
    : execution.result
}

/** Queues on the Codex home lock; `processClosed` settles once the lock is released. */
function startCodexUnderHomeLock(
  start: () =>
    | LocalProcessExecution<InternalTextGenerationResult>
    | Promise<LocalProcessExecution<InternalTextGenerationResult>>,
  target: LocalGenerationTarget,
  operation: TextGenerationOperation,
  commandEnv?: Record<string, string>
): LocalProcessExecution<InternalTextGenerationResult> {
  const laneKey = localGenerationLaneKey(operation, target.cwd, target.laneId)
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
  const queuedCancel = (): void => {
    canceledWhileQueued = true
    publishResult({ success: false, error: 'Generation canceled.', canceled: true })
  }
  setLocalGenerationCancelToken(laneKey, queuedCancel)
  const operationSettled = withCodexHomeProcessLock(
    resolveCodexHomeProcessLockKeyForSpawnEnv(target.env, target.wslDistro, commandEnv),
    async () => {
      if (canceledWhileQueued) {
        publishResult({ success: false, error: 'Generation canceled.', canceled: true })
        return
      }
      const execution = await start()
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
    .finally(() => clearLocalGenerationCancelToken(laneKey, queuedCancel))
  return { result, processClosed: operationSettled }
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
