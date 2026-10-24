import type { BrowserWindow } from 'electron'
import { ipcMain } from 'electron'
import type { Store } from '../../persistence'
import type { Repo } from '../../../shared/repo-types'
import type { RepoHostTarget } from '../../../shared/repo-host-identity'
import { isFolderRepo } from '../../../shared/repo-kind'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { getRepoExecutionHostId, normalizeExecutionHostId } from '../../../shared/execution-host'
import { normalizeRepoBadgeColor } from '../../../shared/repo-badge-color'
import { sanitizeRepoIcon } from '../../../shared/repo-icon'
import { normalizeGhAccountBinding } from '../../../shared/github/account-binding'
import type { GhAccountBinding } from '../../../shared/github/account-binding'
import { normalizeRepoSourceControlAiOverrides } from '../../../shared/source-control-ai'
import {
  normalizeCustomWorktreeVisibilitySources,
  normalizeWorktreeVisibilitySourcePreferences
} from '../../../shared/worktree/visibility-sources'
import { prepareLocalWorktreeRootForRepo } from '../../worktree-root-preparation'
import { commitProvenRepoKindChange } from '../../folder-repo-git-conversion'
import { invalidateAuthorizedRootsCache } from '../registered-worktree-roots-cache'
import { notifyReposChanged } from './repos-changed-notification'
import {
  assertWslMoveProjectWritable,
  isWslMoveSourceHost
} from '../../persistence/moving-wsl-projects/wsl-move-scope-guard'

export function registerRepoUpdateHandler(mainWindow: BrowserWindow, store: Store): void {
  ipcMain.handle(
    'repos:update',
    async (
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
          ghAccount?: GhAccountBinding | null
        }
      }
    ): Promise<Repo | null> => {
      if (isWslMoveSourceHost(args.hostId)) {
        assertWslMoveProjectWritable(store, { repoId: args.repoId })
      }
      // Invalid preferences would silently resolve to auto; discard only the malformed field.
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
      // Null clears the binding; malformed values must not become account selections.
      if ('ghAccount' in updates) {
        if (updates.ghAccount == null) {
          updates.ghAccount = null
        } else {
          const normalized = normalizeGhAccountBinding(updates.ghAccount)
          if (!normalized) {
            delete updates.ghAccount
          } else {
            updates.ghAccount = normalized
          }
        }
      }
      // Worktree materialization trims each path; reject malformed arrays at the IPC boundary.
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
      // Null clears discovery suppression across the transport.
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
      // Null clears Source Control AI; retain the field as undefined for the store update.
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
      // ID-only callers retain legacy first-match behavior.
      const target: RepoHostTarget | undefined = hostId
        ? { id: args.repoId, executionHostId: hostId }
        : store.getRepo(args.repoId)
      if (!target) {
        return null
      }
      const write = (proven: Pick<Repo, 'folderUpgradeGitRootPath'>): Repo | null => {
        if (isWslMoveSourceHost(args.hostId)) {
          assertWslMoveProjectWritable(store, { repoId: args.repoId })
        }
        return store.updateRepo(target, { ...updates, ...proven })
      }
      let updated: Repo | null
      if (updates.kind === 'git') {
        const targetHostId = getRepoExecutionHostId(target)
        const row = store
          .getRepos()
          .find((repo) => repo.id === target.id && getRepoExecutionHostId(repo) === targetHostId)
        updated =
          row && isFolderRepo(row) ? await commitProvenRepoKindChange(store, row, write) : write({})
      } else {
        updated = write({})
      }
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
