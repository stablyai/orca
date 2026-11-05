import { mergeCommandEnvironment } from '../../shared/command-environment'
import { textGenerationFailure } from '../../shared/text-generation-failure-copy'
import { cleanGeneratedCommitMessage } from '../../shared/source-control/ai/generation/commit-message-agent-output'
import { wslDistroForCommand } from '../../shared/wsl-paths'
import type { CommitMessagePlan } from '../../shared/source-control/ai/generation/commit-message-plan'
import { OpenCodeTextTaskError, runOwnedOpenCodeTextTask } from './opencode-owned-text-task'
import { runOpenCodeWslTextTask } from './opencode-wsl-text-task'
import { killSourceControlAgentProcess } from '../text-generation/source-control-agent-termination'
import {
  clearLocalGenerationCancelToken,
  localGenerationLaneKey,
  setLocalGenerationCancelToken
} from '../text-generation/source-control-generation-lanes'
import { SOURCE_CONTROL_GENERATION_TIMEOUT_MS } from '../text-generation/source-control-generation-limits'
import type {
  InternalTextGenerationResult,
  LocalGenerationTarget,
  SpawnSourceControlAgent,
  TextGenerationOperation
} from '../text-generation/source-control-text-generation-types'

export async function runOpenCodeTextTask(input: {
  plan: CommitMessagePlan
  target: LocalGenerationTarget
  operation: TextGenerationOperation
  spawnAgent: SpawnSourceControlAgent
  shouldExecute?: () => boolean
  legacyVariantFlag?: boolean
}): Promise<InternalTextGenerationResult> {
  const task = input.plan.openCodeTask
  if (!task || input.plan.stdinPayload === null) {
    return {
      success: false,
      ...textGenerationFailure('agentCouldNotStart', { label: input.plan.label })
    }
  }
  const canceled = new AbortController()
  // WSL runtime preparation counts against this deadline too; it is not a separate budget.
  const deadline = AbortSignal.timeout(SOURCE_CONTROL_GENERATION_TIMEOUT_MS)
  const signal = AbortSignal.any([canceled.signal, deadline])
  const cancel = () => canceled.abort()
  const lane = localGenerationLaneKey(input.operation, input.target.cwd)
  setLocalGenerationCancelToken(lane, cancel)
  try {
    if (input.shouldExecute?.() === false) {
      cancel()
      canceled.signal.throwIfAborted()
    }
    const distro =
      process.platform === 'win32'
        ? wslDistroForCommand(input.target.cwd, input.target.wslDistro)
        : null
    const common = {
      binary: input.plan.binary,
      prefixArgs: task.prefixArgs,
      cwd: input.target.cwd,
      prompt: input.plan.stdinPayload,
      runArgs: task.runArgs,
      legacyVariantFlag: input.legacyVariantFlag,
      signal
    }
    const rawOutput = distro
      ? await runOpenCodeWslTextTask(
          {
            ...common,
            distro,
            env: input.target.env,
            commandEnv: input.plan.env,
            timeoutMs: SOURCE_CONTROL_GENERATION_TIMEOUT_MS,
            shouldExecute: input.shouldExecute
          },
          { spawnAgent: input.spawnAgent }
        )
      : await runOwnedOpenCodeTextTask({
          ...common,
          env:
            mergeCommandEnvironment(input.target.env, input.plan.env, process.platform) ??
            process.env,
          spawn: input.spawnAgent,
          stop: killSourceControlAgentProcess,
          shouldExecute: input.shouldExecute
        })
    const cleaned = cleanGeneratedCommitMessage(rawOutput)
    if (!cleaned) {
      throw new OpenCodeTextTaskError('session')
    }
    return { success: true, rawOutput: cleaned, agentLabel: input.plan.label }
  } catch (error) {
    if (
      canceled.signal.aborted ||
      (error instanceof OpenCodeTextTaskError && error.stage === 'superseded')
    ) {
      return { success: false, error: 'Generation canceled.', canceled: true }
    }
    return {
      success: false,
      ...(deadline.aborted
        ? textGenerationFailure('timedOut', {
            seconds: SOURCE_CONTROL_GENERATION_TIMEOUT_MS / 1000
          })
        : textGenerationFailure(
            error instanceof OpenCodeTextTaskError && error.stage === 'session'
              ? 'agentReportedError'
              : 'agentCouldNotStart',
            { label: input.plan.label }
          ))
    }
  } finally {
    clearLocalGenerationCancelToken(lane, cancel)
  }
}
