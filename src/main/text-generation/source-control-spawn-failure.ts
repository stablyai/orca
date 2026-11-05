import { WindowsCmdLineBreakError } from '@orca/process-host'
import { WindowsCommandLineBudgetError } from '../../shared/windows-command-line-budget'
import { textGenerationFailure } from '../../shared/text-generation-failure-copy'
import { userFacingUnsafeWindowsBatchArgs } from './source-control-agent-failure'
import type { InternalTextGenerationResult } from './source-control-text-generation-types'

export function localSpawnFailureResult(
  error: unknown,
  label: string
): InternalTextGenerationResult {
  if (error instanceof WindowsCommandLineBudgetError) {
    return { success: false, ...textGenerationFailure('promptTooLargeForWindows', { label }) }
  }
  if (error instanceof WindowsCmdLineBreakError) {
    return { success: false, ...userFacingUnsafeWindowsBatchArgs(label) }
  }
  console.error('[commit-message] Failed to spawn local generator:', error)
  return { success: false, ...textGenerationFailure('agentCouldNotStart', { label }) }
}
