import type { WorkspaceAttachment } from '../../shared/worktree/types'
import { getOptionalNullableNumberFlag, getOptionalNumberFlag } from '../flags'
import { parseReferenceUrls } from '../reference-input'
import { RuntimeClientError } from '../runtime-client'
import { getOptionalWorktreeLinkFlagValue } from './worktree-link-flag-value'
import { getOptionalGitLabLinkFlag } from './worktree-gitlab-link'

type ReviewTargetLinks = {
  linkedIssue: number | null | undefined
  linkedPR?: number | null
  /** `set --pr <url>`: the PR reference to attach, so the row keeps the PR's repository. */
  linkedPRReference?: WorkspaceAttachment
  linkedGitLabIssue?: number | null
  linkedGitLabMR?: number | null
}

function parsePRFlag(
  value: string,
  allowUrl: boolean
): { number: number; reference?: WorkspaceAttachment } {
  const trimmed = value.trim()
  if (/^https?:\/\//i.test(trimmed)) {
    if (!allowUrl) {
      throw new RuntimeClientError(
        'invalid_argument',
        'Pass a positive pull request number for --pr, or attach a PR URL with --reference <url>.'
      )
    }
    const reference = parseReferenceUrls([trimmed])[0]
    if (reference.provider !== 'github' || reference.type !== 'pr') {
      throw new RuntimeClientError(
        'invalid_argument',
        'Pass a GitHub pull request URL such as https://github.com/owner/repo/pull/123 for --pr.'
      )
    }
    return { number: reference.number, reference }
  }
  const number = Number(trimmed)
  if (!/^\d+$/.test(trimmed) || !Number.isSafeInteger(number) || number <= 0) {
    throw new RuntimeClientError('invalid_argument', 'Pass a positive safe integer for --pr.')
  }
  return { number }
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
  const pr = typeof value === 'string' ? parsePRFlag(value, options.nullable === true) : value
  const linkedGitLabIssue = getOptionalGitLabLinkFlag(flags, 'issue', {
    allowNull: options.nullable
  })
  const linkedGitLabMR = getOptionalGitLabLinkFlag(flags, 'mr', { allowNull: options.nullable })
  return {
    linkedIssue: getFlag(flags, 'issue'),
    ...(pr === undefined ? {} : { linkedPR: pr === null ? null : pr.number }),
    ...(pr?.reference ? { linkedPRReference: pr.reference } : {}),
    ...(linkedGitLabIssue === undefined ? {} : { linkedGitLabIssue }),
    ...(linkedGitLabMR === undefined ? {} : { linkedGitLabMR })
  }
}
