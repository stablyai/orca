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
  plan: CommitMessagePlan
  target: LocalGenerationTarget
  operation: TextGenerationOperation
  spawnAgent: SpawnSourceControlAgent
  shouldExecute?: () => boolean
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
  const launch = (plan: CommitMessagePlan, timeoutMs?: number) =>
    runLocalSourceControlPlan({
      plan,
      cwd: input.target.cwd,
      env: wslDistro ? input.target.env : target.env,
      operation: input.operation,
      wslDistro,
      spawnAgent: input.spawnAgent,
      timeoutMs
    })
  const prepare = async (): Promise<LocalProcessExecution<InternalTextGenerationResult>> => {
    if (input.shouldExecute && !input.shouldExecute()) {
      return {
        result: Promise.resolve({ success: false, error: 'Generation canceled.', canceled: true }),
        processClosed: Promise.resolve()
      }
    }
    const canceled = new AbortController()
    const deadlineAt = Date.now() + SOURCE_CONTROL_GENERATION_TIMEOUT_MS
    const deadline = AbortSignal.timeout(SOURCE_CONTROL_GENERATION_TIMEOUT_MS)
    const signal = AbortSignal.any([canceled.signal, deadline])
    const lane = localGenerationLaneKey(input.operation, input.target.cwd)
    const cancel = () => canceled.abort()
    setLocalGenerationCancelToken(lane, cancel)
    let plan: CommitMessagePlan
    try {
      plan = await prepareSourceControlReadOnlyPlan({ ...input, target, signal })
      signal.throwIfAborted()
      if (input.shouldExecute?.() === false) {
        throw new Error('Generation invalidated')
      }
    } catch {
      return {
        result: Promise.resolve(
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
        ),
        processClosed: Promise.resolve()
      }
    } finally {
      clearLocalGenerationCancelToken(lane, cancel)
    }
    return launch(plan, Math.max(1, deadlineAt - Date.now()))
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
  if (input.agentId !== 'codex') {
    const execution = start()
    return Promise.resolve(execution).then((execution) =>
      execution.result.finally(() => execution.processClosed)
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
