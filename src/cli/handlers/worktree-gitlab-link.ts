import { parseGitLabIssueOrMRLink } from '../../shared/new-workspace/gitlab-links'
import { RuntimeClientError } from '../runtime-client'
import { getOptionalWorktreeLinkFlagValue } from './worktree-link-flag-value'

export type GitLabLinkKind = 'issue' | 'mr'

const FLAG_BY_KIND: Record<GitLabLinkKind, string> = {
  issue: 'gitlab-issue',
  mr: 'gitlab-mr'
}

// GitLab issues and merge requests have separate number namespaces.
const PREFIX_BY_KIND: Record<GitLabLinkKind, string> = {
  issue: '#',
  mr: '!'
}

function parseNumericReference(input: string, kind: GitLabLinkKind): number | null {
  const wrongPrefix = PREFIX_BY_KIND[kind === 'issue' ? 'mr' : 'issue']
  if (input.startsWith(wrongPrefix)) {
    return null
  }
  const digits = input.startsWith(PREFIX_BY_KIND[kind]) ? input.slice(1) : input
  if (!/^\d+$/.test(digits)) {
    return null
  }
  const parsed = Number.parseInt(digits, 10)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

export function getOptionalGitLabLinkFlag(
  flags: Map<string, string | boolean>,
  kind: GitLabLinkKind,
  options: { allowNull?: boolean } = {}
): number | null | undefined {
  const name = FLAG_BY_KIND[kind]
  const value = getOptionalWorktreeLinkFlagValue(flags, name, {
    ...options,
    createHint: `a GitLab ${kind === 'issue' ? 'issue' : 'merge request'} number or URL`
  })
  if (value == null) {
    return value
  }

  const trimmed = value.trim()
  if (/^https?:\/\//i.test(trimmed)) {
    const link = parseGitLabIssueOrMRLink(trimmed)
    if (link?.type === kind && Number.isSafeInteger(link.number) && link.number > 0) {
      return link.number
    }
    throw new RuntimeClientError('invalid_argument', badValueMessage(name, kind))
  }

  const number = parseNumericReference(trimmed, kind)
  if (number === null) {
    throw new RuntimeClientError('invalid_argument', badValueMessage(name, kind))
  }
  return number
}

function badValueMessage(name: string, kind: GitLabLinkKind): string {
  return kind === 'issue'
    ? `Pass a GitLab issue number like 42 or #42, a GitLab issue URL, or null to clear --${name}.`
    : `Pass a GitLab merge request number like 42 or !42, a GitLab merge request URL, or null to clear --${name}.`
}
