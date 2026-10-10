import type { CommitMessagePlan } from '../../shared/commit-message-plan'
import { isSshRequestOutcomeUnverifiable } from '../ssh/ssh-channel-multiplexer'
import { WINDOWS_BATCH_UNSAFE_ARGUMENTS_ERROR } from '../win32-utils'
import {
  finalizeFromAgentOutput,
  userFacingUnsafeWindowsBatchArgs
} from './source-control-agent-failure'
import {
  generationTimedOutError,
  sourceControlGenerationTimeoutMs
} from './source-control-generation-limits'
import type {
  InternalTextGenerationResult,
  RemoteCommitMessageExecResult,
  RemoteGenerationTarget,
  TextGenerationOperation
} from './source-control-text-generation-types'

export async function runRemoteSourceControlPlan(input: {
  plan: CommitMessagePlan
  target: RemoteGenerationTarget
  emptyResultName: string
  operation: TextGenerationOperation
}): Promise<InternalTextGenerationResult> {
  const { plan, target, operation } = input
  const timeoutMs = sourceControlGenerationTimeoutMs(operation)
  let result: RemoteCommitMessageExecResult
  try {
    result = await target.execute(plan, target.cwd, timeoutMs, operation)
  } catch (error) {
    console.error('[commit-message] Remote generator request failed:', error)
    if (isSshRequestOutcomeUnverifiable(error)) {
      return {
        success: false,
        error: `${plan.label} took longer than ${timeoutMs / 1000}s to respond and may still be running on the remote host.`
      }
    }
    return {
      success: false,
      error: `${plan.label} could not be reached on the ${target.missingBinaryLocation}. Try again after the SSH connection recovers.`
    }
  }
  if (result.spawnError) {
    if (result.spawnError === WINDOWS_BATCH_UNSAFE_ARGUMENTS_ERROR) {
      return { success: false, error: userFacingUnsafeWindowsBatchArgs(plan.label) }
    }
    if (/ENOENT/i.test(result.spawnError)) {
      return {
        success: false,
        error: `${plan.binary} not found on the ${target.missingBinaryLocation}. Install ${plan.label} there.`
      }
    }
    console.error('[commit-message] Remote generator spawn failed:', result.spawnError)
    return {
      success: false,
      error: `${plan.label} could not be started on the ${target.missingBinaryLocation}. Check the agent command there and try again.`
    }
  }
  if (result.canceled) {
    return { success: false, error: 'Generation canceled.', canceled: true }
  }
  if (result.timedOut) {
    return { success: false, error: generationTimedOutError(plan.label, timeoutMs) }
  }
  return finalizeFromAgentOutput({
    code: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    label: plan.label,
    outputFormat: plan.outputFormat,
    emptyResultName: input.emptyResultName,
    includeLocalMacDnsHint: false,
    includeStdoutDetail: operation !== 'branch-name' && operation !== 'conversation-name'
  })
}
