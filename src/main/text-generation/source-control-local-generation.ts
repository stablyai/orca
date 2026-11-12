import { sourceControlCommandAssignments } from './source-control-agent-launch'
import type { GenerationArgument } from '../../shared/source-control/ai/generation/generation-argument'
import { wslDistroForCommand } from '../../shared/wsl-paths'
import { mergeCommandEnvironment } from '../../shared/command-environment'
import type { CommitMessagePlan } from '../../shared/source-control/ai/generation/commit-message-plan'
import {
  resolveCodexHomeProcessLockKeyForSpawnEnv,
  withCodexHomeProcessLock
} from '../codex-cli/codex-home-process-lock'
import {
  clearLocalGenerationCancelToken,
  localGenerationLaneKey,
  setLocalGenerationCancelToken
} from './source-control-generation-lanes'
import { runLocalSourceControlPlan } from './source-control-local-process'
import { prepareSourceControlReadOnlyPlan } from './source-control-read-only-policy'
import { sourceControlWslPath, sourceControlWslPaths } from './source-control-wsl-paths'
import { SOURCE_CONTROL_GENERATION_TIMEOUT_MS } from './source-control-generation-limits'
import { textGenerationFailure } from '../../shared/text-generation-failure-copy'
import type {
  InternalTextGenerationResult,
  LocalGenerationTarget,
  LocalProcessExecution,
  SpawnSourceControlAgent,
  TextGenerationOperation
} from './source-control-text-generation-types'

export function runLocalPlanForAgent(input: {
  agentId: string
  literalBinary?: boolean
  plan: CommitMessagePlan<GenerationArgument>
  target: LocalGenerationTarget
  operation: TextGenerationOperation
  spawnAgent: SpawnSourceControlAgent
  shouldExecute?: () => boolean
}): Promise<InternalTextGenerationResult> {
  const needsPolicy = ['codex', 'kimi', 'dsh', 'antigravity', 'amp', 'muse'].includes(input.agentId)
  const wslDistro =
    input.plan.promptFile || input.plan.taskFiles?.length || needsPolicy || input.target.wslDistro
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
  const launch = (
    plan: CommitMessagePlan<GenerationArgument>,
    timeoutMs?: number,
    executionCwd?: string
  ) =>
    runLocalSourceControlPlan({
      plan,
      cwd: input.target.cwd,
      executionCwd,
      env: wslDistro ? input.target.env : target.env,
      operation: input.operation,
      wslDistro,
      spawnAgent: (spawn) =>
        input.spawnAgent({ ...spawn, literalWslArgs: process.platform === 'win32' && !!wslDistro }),
      timeoutMs
    })
  const prepare = (): LocalProcessExecution<InternalTextGenerationResult> => {
    const result = Promise.withResolvers<InternalTextGenerationResult>()
    const canceled = new AbortController()
    const deadlineAt = Date.now() + SOURCE_CONTROL_GENERATION_TIMEOUT_MS
    const deadline = AbortSignal.timeout(SOURCE_CONTROL_GENERATION_TIMEOUT_MS)
    const signal = AbortSignal.any([canceled.signal, deadline])
    const lane = localGenerationLaneKey(input.operation, input.target.cwd)
    const failure = (): InternalTextGenerationResult =>
      canceled.signal.aborted || input.shouldExecute?.() === false
        ? { success: false, error: 'Generation canceled.', canceled: true }
        : {
            success: false,
            ...(deadline.aborted
              ? textGenerationFailure('timedOut', {
                  seconds: SOURCE_CONTROL_GENERATION_TIMEOUT_MS / 1000
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
        const preparedTarget =
          process.platform === 'win32' && wslDistro
            ? { ...target, cwd: await sourceControlWslPath(target.cwd, wslDistro, signal) }
            : target
        signal.throwIfAborted()
        const preparedPlan =
          process.platform === 'win32' &&
          wslDistro &&
          !input.literalBinary &&
          sourceControlCommandAssignments(input.plan.env).length
            ? {
                ...input.plan,
                binary: await sourceControlWslPath(input.plan.binary, wslDistro, signal)
              }
            : input.plan
        preparation = prepareSourceControlReadOnlyPlan({
          ...input,
          plan: preparedPlan,
          target: preparedTarget,
          signal
        })
        let plan = await preparation.result
        await preparation.processClosed
        if (process.platform === 'win32' && wslDistro) {
          const operands = plan.args.filter((arg): arg is string => typeof arg === 'string')
          const resolved = await sourceControlWslPaths(operands, wslDistro, signal)
          let index = 0
          plan = {
            ...plan,
            args: plan.args.map((arg) => (typeof arg === 'string' ? resolved[index++] : arg))
          }
        }
        signal.throwIfAborted()
        if (input.shouldExecute?.() === false) {
          canceled.abort()
          signal.throwIfAborted()
        }
        signal.removeEventListener('abort', abort)
        execution = launch(plan, Math.max(1, deadlineAt - Date.now()), preparedTarget.cwd)
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
    if (needsPolicy || (process.platform === 'win32' && wslDistro)) {
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
  if (input.agentId !== 'codex') {
    const execution = start()
    return Promise.resolve(execution).then((execution) =>
      input.shouldExecute
        ? execution.result.finally(() => execution.processClosed)
        : execution.result
    )
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
  return awaitSettlement ? result.finally(() => operationSettled) : result
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
