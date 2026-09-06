import { sanitizeRepoIcon, type RepoIcon } from '../../../src/shared/repo-icon'
import {
  MOBILE_WEB_REPOSITORY_LIMIT,
  MobileWebWorkspaceRepositoriesResultSchema,
  MobileWebWorkspaceSettingsSnapshotResultSchema,
  MobileWebWorkspaceViewSettingsSchema,
  type MobileWebWorkspaceRepositoriesResult,
  type MobileWebWorkspaceViewSettings
} from '../../../src/shared/mobile-web/workspace-presentation-contract'
import type { MobileWebWorkspaceAuthority } from './mobile-web-workspace-authority'

const MAX_BRIDGE_REPO_ICON_SOURCE_LENGTH = 8192

export function mobileWebWorkspaceRepositories(
  result: unknown,
  authority: MobileWebWorkspaceAuthority
): MobileWebWorkspaceRepositoriesResult {
  if (!isRecord(result) || !Array.isArray(result.repos)) {
    throw new Error('mobile_web_workspace_repositories_invalid')
  }
  const repos = result.repos.filter(
    (value): value is Record<string, unknown> & { id: string } =>
      isRecord(value) && typeof value.id === 'string' && value.id.length > 0
  )
  authority.synchronizeRepositories(repos.map((repo) => repo.id))
  const repositories = repos.slice(0, MOBILE_WEB_REPOSITORY_LIMIT).map((repo) => {
    const repoIcon = bridgeRepoIcon(repo.repoIcon)
    return {
      id: authority.pageRepoId(repo.id),
      displayName: displayRepoName(repo.displayName),
      ...(boundedOptionalText(repo.badgeColor, 64)
        ? { badgeColor: boundedOptionalText(repo.badgeColor, 64)! }
        : {}),
      ...(repoIcon !== undefined ? { repoIcon } : {})
    }
  })
  return MobileWebWorkspaceRepositoriesResultSchema.parse({
    repositories,
    truncated: repos.length > repositories.length
  })
}

export function mobileWebWorkspaceSettings(
  result: unknown,
  authority: MobileWebWorkspaceAuthority
): { settings: MobileWebWorkspaceViewSettings | null } {
  if (!isRecord(result)) {
    throw new Error('mobile_web_workspace_settings_invalid')
  }
  if (!isRecord(result.ui)) {
    return { settings: null }
  }
  const settings = settingsProjection(result.ui)
  if (settings.filterRepoIds) {
    settings.filterRepoIds = settings.filterRepoIds.flatMap((hostRepoId) => {
      try {
        return [authority.pageRepoId(hostRepoId)]
      } catch {
        return []
      }
    })
  }
  return MobileWebWorkspaceSettingsSnapshotResultSchema.parse({ settings })
}

export function hostWorkspaceSettings(
  value: unknown,
  authority: MobileWebWorkspaceAuthority
): MobileWebWorkspaceViewSettings {
  const settings = MobileWebWorkspaceViewSettingsSchema.parse(value)
  return {
    ...settings,
    ...(settings.filterRepoIds
      ? { filterRepoIds: settings.filterRepoIds.map((id) => authority.hostRepoId(id)) }
      : {})
  }
}

function settingsProjection(value: Record<string, unknown>): MobileWebWorkspaceViewSettings {
  return MobileWebWorkspaceViewSettingsSchema.parse({
    ...(typeof value.groupBy === 'string' ? { groupBy: value.groupBy } : {}),
    ...(typeof value.sortBy === 'string' ? { sortBy: value.sortBy } : {}),
    ...(typeof value.hideSleepingWorkspaces === 'boolean'
      ? { hideSleepingWorkspaces: value.hideSleepingWorkspaces }
      : {}),
    ...(typeof value.hideDefaultBranchWorkspace === 'boolean'
      ? { hideDefaultBranchWorkspace: value.hideDefaultBranchWorkspace }
      : {}),
    ...(Array.isArray(value.filterRepoIds) ? { filterRepoIds: value.filterRepoIds } : {}),
    ...(Array.isArray(value.collapsedGroups) ? { collapsedGroups: value.collapsedGroups } : {}),
    ...(Array.isArray(value.workspaceStatuses)
      ? { workspaceStatuses: value.workspaceStatuses }
      : {})
  })
}

function bridgeRepoIcon(value: unknown): RepoIcon | null | undefined {
  const icon = sanitizeRepoIcon(value)
  if (icon?.type === 'image' && icon.src.length > MAX_BRIDGE_REPO_ICON_SOURCE_LENGTH) {
    return undefined
  }
  return icon
}

function displayRepoName(value: unknown): string {
  const displayName = boundedOptionalText(value, 240) ?? 'Repository'
  if (
    displayName.startsWith('/') ||
    /^[A-Za-z]:[\\/]/.test(displayName) ||
    displayName.startsWith('\\\\')
  ) {
    return (
      displayName
        .replace(/[\\/]+$/, '')
        .split(/[\\/]/)
        .at(-1)
        ?.slice(0, 240) || 'Repository'
    )
  }
  return displayName
}

function boundedOptionalText(value: unknown, maximum: number): string | null {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, maximum) : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
