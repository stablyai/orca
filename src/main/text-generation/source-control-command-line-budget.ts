import {
  textGenerationFailure,
  type TextGenerationFailureFields
} from '../../shared/text-generation-failure-copy'
import type { CommitMessagePlan } from '../../shared/commit-message-plan'
import { commandLineLength, MAX_COMMAND_LINE_CHARS } from '../../shared/windows-command-line-budget'

// Linux caps each argv entry in bytes (128KiB on 4KiB pages), before total argv capacity; reserve headroom for single-prompt arguments.
const LINUX_SINGLE_ARGUMENT_BYTE_BUDGET = 120 * 1024
/** Whether the plan's argv plus reserve fits this host's limit: UTF-16 units on Windows, bytes per argument on Linux. */
export function fitsLocalCommandLine(plan: CommitMessagePlan, reserve = 0): boolean {
  if (process.platform === 'win32') {
    return commandLineLength([plan.binary, ...plan.args]) + reserve <= MAX_COMMAND_LINE_CHARS
  }
  if (process.platform === 'linux') {
    return plan.args.every(
      (arg) => Buffer.byteLength(arg, 'utf8') + reserve <= LINUX_SINGLE_ARGUMENT_BYTE_BUDGET
    )
  }
  return true
}

export function argumentBudgetFailure(plan: CommitMessagePlan): TextGenerationFailureFields | null {
  if (fitsLocalCommandLine(plan)) {
    return null
  }
  return textGenerationFailure(
    process.platform === 'win32' ? 'promptTooLargeForWindows' : 'promptTooLargeForArgument',
    { label: plan.label }
  )
}
