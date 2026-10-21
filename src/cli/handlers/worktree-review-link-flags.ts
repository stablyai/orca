import { getOptionalNullableNumberFlag, getOptionalNumberFlag } from '../flags'
import { RuntimeClientError } from '../runtime-client'
import { getOptionalWorktreeLinkFlagValue } from './worktree-link-flag-value'
import { getOptionalGitLabLinkFlag } from './worktree-gitlab-link'

type ReviewTargetLinks = {
  linkedIssue: number | null | undefined
  linkedPR?: number | null
  linkedGitLabIssue?: number | null
  linkedGitLabMR?: number | null
}

// Why: only `set` may clear a link, so `create` parses the same flags non-nullable.
export function getReviewTargetLinkFlags(
  flags: Map<string, string | boolean>,
  options: { nullable?: boolean } = {}
): ReviewTargetLinks {
  const getFlag = options.nullable ? getOptionalNullableNumberFlag : getOptionalNumberFlag
  const value = getOptionalWorktreeLinkFlagValue(flags, 'pr', {
    allowNull: options.nullable,
    createHint: 'a positive pull request number'
  })
  const linkedPR = value == null ? value : Number(value)
  if (
    typeof value === 'string' &&
    typeof linkedPR === 'number' &&
    (!/^\d+$/.test(value.trim()) || !Number.isSafeInteger(linkedPR) || linkedPR <= 0)
  ) {
    throw new RuntimeClientError('invalid_argument', 'Pass a positive safe integer for --pr.')
  }
  const linkedGitLabIssue = getOptionalGitLabLinkFlag(flags, 'issue', {
    allowNull: options.nullable
  })
  const linkedGitLabMR = getOptionalGitLabLinkFlag(flags, 'mr', { allowNull: options.nullable })
  return {
    linkedIssue: getFlag(flags, 'issue'),
    ...(linkedPR === undefined ? {} : { linkedPR }),
    ...(linkedGitLabIssue === undefined ? {} : { linkedGitLabIssue }),
    ...(linkedGitLabMR === undefined ? {} : { linkedGitLabMR })
  }
}
