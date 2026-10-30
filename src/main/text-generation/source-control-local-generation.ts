import { wslDistroForCommand } from '../../shared/wsl-paths'
import { mergeCommandEnvironment } from '../../shared/command-environment'
import type { CommitMessagePlan } from '../../shared/commit-message-plan'
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
    if (input.shouldExecute && !input.shouldExecute()) {
      return {
        result: Promise.resolve({ success: false, error: 'Generation canceled.', canceled: true }),
        processClosed: Promise.resolve()
      }
    }
    return runLocalSourceControlPlan({
      plan: input.plan,
      cwd: input.target.cwd,
      env: wslDistro ? input.target.env : target.env,
      operation: input.operation,
      wslDistro,
      spawnAgent: input.spawnAgent
    })
  }
  if (input.agentId !== 'codex') {
    const execution = start()
    return input.shouldExecute
      ? execution.result.finally(() => execution.processClosed)
      : execution.result
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
