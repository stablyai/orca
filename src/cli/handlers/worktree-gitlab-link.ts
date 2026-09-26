import { parseGitLabIssueOrMRLink } from '../../shared/new-workspace/gitlab-links'
import { RuntimeClientError } from '../runtime-client'

/** Which GitLab slot a flag writes. The two are separate namespaces on GitLab,
 *  so a reference to one is never a valid value for the other. */
export type GitLabLinkKind = 'issue' | 'mr'

const FLAG_BY_KIND: Record<GitLabLinkKind, string> = {
  issue: 'gitlab-issue',
  mr: 'gitlab-mr'
}

// Why: GitLab writes `#42` for an issue and `!42` for a merge request. Accepting
// the wrong prefix would silently link the other namespace's number.
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
  // Why: `/^\d+$/` accepts 400 digits, which parseInt turns into Infinity —
  // JSON.stringify would then persist `null` over the link it meant to set.
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

/**
 * Resolve `--gitlab-issue` / `--gitlab-mr` into the number to persist.
 * `undefined` means the flag was absent and the slot must be left alone;
 * `null` means the caller asked to clear it.
 */
export function getOptionalGitLabLinkFlag(
  flags: Map<string, string | boolean>,
  kind: GitLabLinkKind,
  options: { allowNull?: boolean } = {}
): number | null | undefined {
  const name = FLAG_BY_KIND[kind]
  const value = getPresentStringFlag(flags, name)
  if (value === undefined) {
    return undefined
  }

  const trimmed = value.trim()
  if (trimmed.toLowerCase() === 'null') {
    if (!options.allowNull) {
      throw new RuntimeClientError(
        'invalid_argument',
        `Omit --${name} on create, or pass a GitLab ${kind === 'issue' ? 'issue' : 'merge request'} number or URL.`
      )
    }
    return null
  }

  if (/^https?:\/\//i.test(trimmed)) {
    const link = parseGitLabIssueOrMRLink(trimmed)
    // Why: an issue URL passed to --gitlab-mr names a real GitLab item, just not
    // this one. Taking its number would link a merge request that may not exist.
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

function getPresentStringFlag(
  flags: Map<string, string | boolean>,
  name: string
): string | undefined {
  if (!flags.has(name)) {
    return undefined
  }
  const value = flags.get(name)
  if (typeof value === 'string' && value.length > 0) {
    return value
  }
  throw new RuntimeClientError('invalid_argument', `Missing value for --${name}`)
}
