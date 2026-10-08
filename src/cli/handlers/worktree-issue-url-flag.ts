import { parseIssueUrl } from '../../shared/issue-link-input'
import { RuntimeClientError } from '../runtime-client'
import { getOptionalWorktreeLinkFlagValue } from './worktree-link-flag-value'

export function getOptionalIssueUrlFlag(
  flags: Map<string, string | boolean>,
  name: string
): { linkedIssueUrl: string | null } | undefined {
  const value = getOptionalWorktreeLinkFlagValue(flags, name, { allowNull: true })
  if (value === undefined) {
    return undefined
  }
  if (value === null) {
    return { linkedIssueUrl: null }
  }
  const url = parseIssueUrl(value)
  if (!url) {
    throw new RuntimeClientError('invalid_argument', 'Pass an http(s) issue URL, or null to clear.')
  }
  return { linkedIssueUrl: url }
}
