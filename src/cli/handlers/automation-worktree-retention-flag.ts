import {
  parseAutomationWorktreeRetentionFlag,
  type AutomationWorktreeRetention
} from '../../shared/automation-worktree-retention'
import { getOptionalStringFlag } from '../flags'
import { RuntimeClientError } from '../runtime-client'

export function getWorktreeRetentionFlag(
  flags: Map<string, string | boolean>
): AutomationWorktreeRetention | null | undefined {
  const raw = getOptionalStringFlag(flags, 'worktree-retention')
  if (raw === undefined) {
    return undefined
  }
  const parsed = parseAutomationWorktreeRetentionFlag(raw)
  if (parsed === 'invalid') {
    throw new RuntimeClientError(
      'invalid_argument',
      '--worktree-retention must be keep, reclaim-clean-success, keep-last:<1-100>, or default'
    )
  }
  return parsed
}
