import { getRuntimePathBasename } from '../../shared/cross-platform-path'
import {
  computeBranchName,
  getConfiguredBranchPrefix,
  sanitizeWorktreeName
} from './worktree-logic'

export type WorktreeFolderNameTokens = {
  projectName: string
  workspaceName: string
  gitBranchName: string
  gitBranchSlug: string
  branchPrefix: string
  gitUsername: string
  date: string
  shortId: string
}

type WorktreeFolderNameSettings = { branchPrefix: string; branchPrefixCustom?: string }

const TOKEN_PATTERN = /%(\w+)%/g

export function expandWorktreeFolderName(
  template: string | undefined,
  tokens: WorktreeFolderNameTokens
): string | null {
  if (!template?.trim()) {
    return null
  }

  const expanded = template.replace(TOKEN_PATTERN, (_match, tokenName: string) =>
    readTokenValue(tokenName, tokens)
  )

  try {
    const sanitized = sanitizeWorktreeName(expanded)
    return sanitized || null
  } catch {
    return null
  }
}

export function buildWorktreeFolderNameTokens(input: {
  repoPath: string
  sanitizedName: string
  branchName: string | undefined
  settings: WorktreeFolderNameSettings
  username: string | null
  now: number
  shortId: string
}): WorktreeFolderNameTokens {
  const username = input.username ?? null
  const gitBranchName =
    input.branchName?.trim() || computeBranchName(input.sanitizedName, input.settings, username)

  return {
    projectName: getRuntimePathBasename(input.repoPath).replace(/\.git$/, ''),
    workspaceName: input.sanitizedName,
    gitBranchName,
    gitBranchSlug: gitBranchName.replace(/\//g, '-'),
    branchPrefix: getConfiguredBranchPrefix(input.settings, username) ?? '',
    gitUsername: username ?? '',
    date: formatLocalDate(input.now),
    shortId: input.shortId
  }
}

function readTokenValue(tokenName: string, tokens: WorktreeFolderNameTokens): string {
  switch (tokenName) {
    case 'projectName':
    case 'repoName':
      return tokens.projectName
    case 'workspaceName':
      return tokens.workspaceName
    case 'gitBranchName':
      return tokens.gitBranchName
    case 'gitBranchSlug':
      return tokens.gitBranchSlug
    case 'branchPrefix':
      return tokens.branchPrefix
    case 'gitUsername':
      return tokens.gitUsername
    case 'date':
      return tokens.date
    case 'shortId':
      return tokens.shortId
    default:
      return ''
  }
}

function formatLocalDate(now: number): string {
  const date = new Date(now)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}
