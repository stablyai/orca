import type { RepoProjectHostSetupMethod } from '../../../shared/project-types'
import type { Repo } from '../../../shared/repo-types'
import type { GitRemoteIdentity } from '../../../shared/git-remote-identity'
import { normalizeRepoBadgeColor } from '../../../shared/repo-badge-color'
import { sanitizeRepoIcon } from '../../../shared/repo-icon'
import { normalizeGhAccountBinding } from '../../../shared/github/account-binding'
import { normalizeJiraProjectReference } from '../../../shared/jira/jira-project-reference'
import type { GhAccountBinding } from '../../../shared/github/account-binding'
import {
  normalizeCustomWorktreeVisibilitySources,
  normalizeWorktreeVisibilitySourcePreferences
} from '../../../shared/worktree/visibility-sources'

export function sanitizeRepoUpstream(value: unknown): Repo['upstream'] | undefined {
  if (value === undefined) {
    return undefined
  }
  if (value === null) {
    return null
  }
  if (!value || typeof value !== 'object') {
    return undefined
  }
  const candidate = value as { owner?: unknown; repo?: unknown; host?: unknown }
  const owner = typeof candidate.owner === 'string' ? candidate.owner.trim() : ''
  const repo = typeof candidate.repo === 'string' ? candidate.repo.trim() : ''
  if (!owner || !repo) {
    return undefined
  }
  // Preserve upstream host identity to distinguish GHES forks from same-named github.com repos.
  const host = typeof candidate.host === 'string' ? candidate.host.trim() : ''
  return host ? { owner, repo, host } : { owner, repo }
}

export function sanitizeGitRemoteIdentity(value: unknown): GitRemoteIdentity | null | undefined {
  // Null means resolved with no usable remote; absence means identity probing is pending.
  if (value === null) {
    return null
  }
  if (!value || typeof value !== 'object') {
    return undefined
  }
  const candidate = value as {
    canonicalKey?: unknown
    remoteName?: unknown
    remoteUrl?: unknown
  }
  const canonicalKey =
    typeof candidate.canonicalKey === 'string' ? candidate.canonicalKey.trim() : ''
  const remoteName = typeof candidate.remoteName === 'string' ? candidate.remoteName.trim() : ''
  const remoteUrl = typeof candidate.remoteUrl === 'string' ? candidate.remoteUrl.trim() : ''
  return canonicalKey && remoteName && remoteUrl
    ? { canonicalKey, remoteName, remoteUrl }
    : undefined
}

export function sanitizeRepoProjectHostSetupMethod(
  value: unknown
): RepoProjectHostSetupMethod | undefined {
  return value === 'imported-existing-folder' || value === 'cloned' ? value : undefined
}

export function sanitizeForkSyncMode(value: unknown): Repo['forkSyncMode'] | undefined {
  return value === 'ask' || value === 'safe-auto' || value === 'off' ? value : undefined
}

export function sanitizeRepoUpdatesForPersistence<
  T extends Partial<
    Pick<
      Repo,
      | 'badgeColor'
      | 'repoIcon'
      | 'upstream'
      | 'gitRemoteIdentity'
      | 'worktreeBasePath'
      | 'projectHostSetupMethod'
      | 'forkSyncMode'
      | 'defaultJiraProject'
      | 'customWorktreeVisibilitySources'
      | 'worktreeVisibilitySourcePreferences'
    >
  > & {
    ghAccount?: GhAccountBinding | null
  }
>(updates: T): T {
  const sanitized = { ...updates }
  if ('defaultJiraProject' in sanitized) {
    const reference = normalizeJiraProjectReference(sanitized.defaultJiraProject)
    if (reference === undefined) {
      delete sanitized.defaultJiraProject
    } else {
      sanitized.defaultJiraProject = reference
    }
  }
  if ('badgeColor' in sanitized) {
    const badgeColor = normalizeRepoBadgeColor(sanitized.badgeColor)
    if (!badgeColor) {
      delete sanitized.badgeColor
    } else {
      sanitized.badgeColor = badgeColor
    }
  }
  if ('repoIcon' in sanitized) {
    const repoIcon = sanitizeRepoIcon(sanitized.repoIcon)
    if (repoIcon === undefined) {
      delete sanitized.repoIcon
    } else {
      sanitized.repoIcon = repoIcon
    }
  }
  // Preserve explicit null markers; discard only malformed values.
  if ('upstream' in sanitized) {
    const upstream = sanitizeRepoUpstream(sanitized.upstream)
    if (upstream === undefined) {
      delete sanitized.upstream
    } else {
      sanitized.upstream = upstream
    }
  }
  if ('gitRemoteIdentity' in sanitized) {
    const gitRemoteIdentity = sanitizeGitRemoteIdentity(sanitized.gitRemoteIdentity)
    if (gitRemoteIdentity === undefined) {
      delete sanitized.gitRemoteIdentity
    } else {
      sanitized.gitRemoteIdentity = gitRemoteIdentity
    }
  }
  if ('worktreeBasePath' in sanitized && sanitized.worktreeBasePath !== undefined) {
    if (typeof sanitized.worktreeBasePath === 'string') {
      sanitized.worktreeBasePath = sanitized.worktreeBasePath.trim() || undefined
    } else {
      delete sanitized.worktreeBasePath
    }
  }
  if ('projectHostSetupMethod' in sanitized) {
    const setupMethod = sanitizeRepoProjectHostSetupMethod(sanitized.projectHostSetupMethod)
    if (setupMethod === undefined) {
      delete sanitized.projectHostSetupMethod
    } else {
      sanitized.projectHostSetupMethod = setupMethod
    }
  }
  if ('forkSyncMode' in sanitized) {
    const forkSyncMode = sanitizeForkSyncMode(sanitized.forkSyncMode)
    if (forkSyncMode === undefined) {
      delete sanitized.forkSyncMode
    } else {
      sanitized.forkSyncMode = forkSyncMode
    }
  }
  // Null explicitly clears ghAccount; only malformed shapes are discarded.
  if ('ghAccount' in sanitized && sanitized.ghAccount != null) {
    const ghAccount = normalizeGhAccountBinding(sanitized.ghAccount)
    if (!ghAccount) {
      delete sanitized.ghAccount
    } else {
      sanitized.ghAccount = ghAccount
    }
  }
  if ('customWorktreeVisibilitySources' in sanitized) {
    const sources = normalizeCustomWorktreeVisibilitySources(
      sanitized.customWorktreeVisibilitySources
    )
    if (!sources) {
      delete sanitized.customWorktreeVisibilitySources
    } else {
      sanitized.customWorktreeVisibilitySources = sources
    }
  }
  if ('worktreeVisibilitySourcePreferences' in sanitized) {
    const preferences = normalizeWorktreeVisibilitySourcePreferences(
      sanitized.worktreeVisibilitySourcePreferences
    )
    if (!preferences) {
      delete sanitized.worktreeVisibilitySourcePreferences
    } else {
      sanitized.worktreeVisibilitySourcePreferences = preferences
    }
  }
  return sanitized
}
