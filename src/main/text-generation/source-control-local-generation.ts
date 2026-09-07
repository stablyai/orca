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
  emptyResultName: string
  operation: TextGenerationOperation
  spawnAgent: SpawnSourceControlAgent
}): Promise<InternalTextGenerationResult> {
  const start = (
    holdHomeLockUntilExit = false
  ): LocalProcessExecution<InternalTextGenerationResult> =>
    runLocalSourceControlPlan({
      plan: input.plan,
      cwd: input.target.cwd,
      env: input.target.env,
      emptyResultName: input.emptyResultName,
      operation: input.operation,
      wslDistro: input.target.wslDistro,
      holdHomeLockUntilExit,
      spawnAgent: input.spawnAgent
    })
  if (input.agentId !== 'codex') {
    return start().result
  }
  return runCodexLocalPlanUnderHomeLock(start, input.target, input.operation)
}

function runCodexLocalPlanUnderHomeLock(
  start: (holdHomeLockUntilExit: boolean) => LocalProcessExecution<InternalTextGenerationResult>,
  target: LocalGenerationTarget,
  operation: TextGenerationOperation
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
  void withCodexHomeProcessLock(
    resolveCodexHomeProcessLockKeyForSpawnEnv(target.env, target.wslDistro),
    async () => {
      if (canceledWhileQueued) {
        publishResult({ success: false, error: 'Generation canceled.', canceled: true })
        return
      }
      const execution = start(true)
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
  return result
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
