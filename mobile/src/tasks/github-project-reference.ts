import type { GitHubProjectIdentity } from '../../../src/shared/github-project-identity'

export type GitHubProjectOwnerType = GitHubProjectIdentity['ownerType']
export type GitHubProjectRef = GitHubProjectIdentity
export type GitHubProjectSettings = {
  pinned: GitHubProjectRef[]
  recent: Array<GitHubProjectRef & { lastOpenedAt: string }>
  lastViewByProject: Record<string, { viewId: string }>
  activeProject: GitHubProjectRef | null
}
export type GitHubProjectSummary = GitHubProjectRef & {
  id: string
  title: string
  url: string
  source: string
}
export type GitHubProjectPartialFailure = { owner: string; message: string }
export type GitHubProjectViewSummary = {
  id: string
  number: number
  name: string
  layout: 'TABLE_LAYOUT' | 'BOARD_LAYOUT' | 'ROADMAP_LAYOUT'
}

export type ParsedGitHubProjectInput = {
  owner: string
  number: number
  host?: string
  viewNumber?: number
}

const OWNER_RE = /^[A-Za-z0-9][A-Za-z0-9-]*$/

function positiveInteger(value: string | undefined): number | null {
  if (!value || !/^\d+$/.test(value)) {
    return null
  }
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

export function parseGitHubProjectInput(input: string): ParsedGitHubProjectInput | null {
  const trimmed = input.trim()
  const short = /^([A-Za-z0-9][A-Za-z0-9-]*)\/(\d+)$/.exec(trimmed)
  if (short) {
    const number = positiveInteger(short[2])
    return number ? { owner: short[1]!, number } : null
  }

  try {
    const url = new URL(trimmed)
    if (
      (url.protocol !== 'https:' && url.protocol !== 'http:') ||
      url.username ||
      url.password ||
      !url.host
    ) {
      return null
    }
    const parts = url.pathname.split('/').filter(Boolean)
    const hasView = parts.length === 6 && parts[4] === 'views'
    if (
      (parts[0] !== 'orgs' && parts[0] !== 'users') ||
      !OWNER_RE.test(parts[1] ?? '') ||
      parts[2] !== 'projects' ||
      (parts.length !== 4 && !hasView)
    ) {
      return null
    }
    const number = positiveInteger(parts[3])
    const viewNumber = hasView ? positiveInteger(parts[5]) : null
    if (!number || (hasView && !viewNumber)) {
      return null
    }
    return {
      owner: parts[1]!,
      number,
      host: url.host.toLowerCase(),
      ...(viewNumber ? { viewNumber } : {})
    }
  } catch {
    return null
  }
}
