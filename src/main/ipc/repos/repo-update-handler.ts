import type { BrowserWindow } from 'electron'
import { ipcMain } from 'electron'
import type { Store } from '../../persistence'
import type { Repo } from '../../../shared/repo-types'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { normalizeExecutionHostId } from '../../../shared/execution-host'
import { normalizeRepoBadgeColor } from '../../../shared/repo-badge-color'
import { sanitizeRepoIcon } from '../../../shared/repo-icon'
import { normalizeRepoSourceControlAiOverrides } from '../../../shared/source-control-ai'
import {
  normalizeCustomWorktreeVisibilitySources,
  normalizeWorktreeVisibilitySourcePreferences
} from '../../../shared/worktree/visibility-sources'
import { prepareLocalWorktreeRootForRepo } from '../../worktree-root-preparation'
import { invalidateAuthorizedRootsCache } from '../registered-worktree-roots-cache'
import { notifyReposChanged } from './repos-changed-notification'

export function registerRepoUpdateHandler(mainWindow: BrowserWindow, store: Store): void {
  ipcMain.handle(
    'repos:update',
    (
      _event,
      args: {
        repoId: string
        hostId?: ExecutionHostId
        updates: Partial<
          Pick<
            Repo,
            | 'displayName'
            | 'badgeColor'
            | 'repoIcon'
            | 'upstream'
            | 'hookSettings'
            | 'worktreeBaseRef'
            | 'worktreeBasePath'
            | 'kind'
            | 'symlinkPaths'
            | 'issueSourcePreference'
            | 'forkSyncMode'
            | 'externalWorktreeVisibilityPromptDismissedAt'
            | 'externalWorktreeInboxBaselinePaths'
            | 'importedExternalWorktreePaths'
            | 'customWorktreeVisibilitySources'
            | 'worktreeVisibilitySourcePreferences'
            | 'projectGroupId'
            | 'projectGroupOrder'
          >
        > & {
          externalWorktreeVisibility?: Repo['externalWorktreeVisibility'] | null
          agentWorktreeVisibility?: Repo['agentWorktreeVisibility'] | null
          sourceControlAi?: Repo['sourceControlAi'] | null
          externalWorktreeDiscoverySuppressedAt?:
            | Repo['externalWorktreeDiscoverySuppressedAt']
            | null
        }
      }
    ) => {
      // Why: TS is erased at runtime, so a garbage preference would silently collapse to 'auto' in resolveIssueSource; strip it, keeping other fields.
      const updates = { ...args.updates }
      if (
        'issueSourcePreference' in updates &&
        updates.issueSourcePreference !== undefined &&
        updates.issueSourcePreference !== 'upstream' &&
        updates.issueSourcePreference !== 'origin' &&
        updates.issueSourcePreference !== 'auto'
      ) {
        delete updates.issueSourcePreference
      }
      if (
        'forkSyncMode' in updates &&
        updates.forkSyncMode !== undefined &&
        updates.forkSyncMode !== 'ask' &&
        updates.forkSyncMode !== 'safe-auto' &&
        updates.forkSyncMode !== 'off'
      ) {
        delete updates.forkSyncMode
      }
      // Why: worktree materialization calls .trim() per entry, so strip non-string[] at the boundary to avoid a silent throw later.
      if ('symlinkPaths' in updates && updates.symlinkPaths !== undefined) {
        const v = updates.symlinkPaths as unknown
        if (!Array.isArray(v) || !v.every((e) => typeof e === 'string')) {
          delete updates.symlinkPaths
        }
      }
      if ('worktreeBasePath' in updates && updates.worktreeBasePath !== undefined) {
        const v = updates.worktreeBasePath as unknown
        if (typeof v !== 'string') {
          delete updates.worktreeBasePath
        } else {
          updates.worktreeBasePath = v.trim() || undefined
        }
      }
      if ('repoIcon' in updates) {
        const repoIcon = sanitizeRepoIcon(updates.repoIcon)
        if (repoIcon === undefined) {
          delete updates.repoIcon
        } else {
          updates.repoIcon = repoIcon
        }
      }
      if ('badgeColor' in updates) {
        const badgeColor = normalizeRepoBadgeColor(updates.badgeColor)
        if (!badgeColor) {
          delete updates.badgeColor
        } else {
          updates.badgeColor = badgeColor
        }
      }
      if ('externalWorktreeVisibility' in updates && updates.externalWorktreeVisibility === null) {
        updates.externalWorktreeVisibility = undefined
      } else if (
        'externalWorktreeVisibility' in updates &&
        updates.externalWorktreeVisibility !== undefined &&
        updates.externalWorktreeVisibility !== 'hide' &&
        updates.externalWorktreeVisibility !== 'show'
      ) {
        delete updates.externalWorktreeVisibility
      }
      if (
        'agentWorktreeVisibility' in updates &&
        updates.agentWorktreeVisibility !== null &&
        updates.agentWorktreeVisibility !== undefined &&
        updates.agentWorktreeVisibility !== 'hide' &&
        updates.agentWorktreeVisibility !== 'show'
      ) {
        delete updates.agentWorktreeVisibility
      }
      if ('customWorktreeVisibilitySources' in updates) {
        const normalized = normalizeCustomWorktreeVisibilitySources(
          updates.customWorktreeVisibilitySources
        )
        if (!normalized) {
          delete updates.customWorktreeVisibilitySources
        } else {
          updates.customWorktreeVisibilitySources = normalized
        }
      }
      if ('worktreeVisibilitySourcePreferences' in updates) {
        const normalized = normalizeWorktreeVisibilitySourcePreferences(
          updates.worktreeVisibilitySourcePreferences
        )
        if (!normalized) {
          delete updates.worktreeVisibilitySourcePreferences
        } else {
          updates.worktreeVisibilitySourcePreferences = normalized
        }
      }
      if (
        'externalWorktreeVisibilityPromptDismissedAt' in updates &&
        updates.externalWorktreeVisibilityPromptDismissedAt !== undefined &&
        (typeof updates.externalWorktreeVisibilityPromptDismissedAt !== 'number' ||
          !Number.isFinite(updates.externalWorktreeVisibilityPromptDismissedAt))
      ) {
        delete updates.externalWorktreeVisibilityPromptDismissedAt
      }
      // Why: null is the transport sentinel for clearing discovery suppression.
      if (
        'externalWorktreeDiscoverySuppressedAt' in updates &&
        updates.externalWorktreeDiscoverySuppressedAt === null
      ) {
        updates.externalWorktreeDiscoverySuppressedAt = undefined
      } else if (
        'externalWorktreeDiscoverySuppressedAt' in updates &&
        updates.externalWorktreeDiscoverySuppressedAt !== undefined &&
        (typeof updates.externalWorktreeDiscoverySuppressedAt !== 'number' ||
          !Number.isFinite(updates.externalWorktreeDiscoverySuppressedAt))
      ) {
        delete updates.externalWorktreeDiscoverySuppressedAt
      }
      if (
        'externalWorktreeInboxBaselinePaths' in updates &&
        updates.externalWorktreeInboxBaselinePaths !== undefined
      ) {
        const value = updates.externalWorktreeInboxBaselinePaths as unknown
        if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
          delete updates.externalWorktreeInboxBaselinePaths
        }
      }
      if (
        'importedExternalWorktreePaths' in updates &&
        updates.importedExternalWorktreePaths !== undefined
      ) {
        const value = updates.importedExternalWorktreePaths as unknown
        if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
          delete updates.importedExternalWorktreePaths
        }
      }
      // Why: null is the transport sentinel for clearing Source Control AI, so flow it through as undefined instead of deleting.
      if ('sourceControlAi' in updates && updates.sourceControlAi === null) {
        updates.sourceControlAi = undefined
      } else if ('sourceControlAi' in updates && updates.sourceControlAi !== undefined) {
        const normalizedSourceControlAi = normalizeRepoSourceControlAiOverrides(
          updates.sourceControlAi
        )
        if (normalizedSourceControlAi === undefined) {
          delete updates.sourceControlAi
        } else {
          updates.sourceControlAi = normalizedSourceControlAi
        }
      }
      const hostId = args.hostId ? normalizeExecutionHostId(args.hostId) : null
      if (args.hostId && !hostId) {
        return null
      }
      const updated = hostId
        ? store.updateRepo(args.repoId, updates, hostId)
        : store.updateRepo(args.repoId, updates)
      if (updated) {
        if ('worktreeBasePath' in updates) {
          void prepareLocalWorktreeRootForRepo(store, updated)
          invalidateAuthorizedRootsCache()
        }
        notifyReposChanged(mainWindow)
      }
      return updated
    }
  )
}
