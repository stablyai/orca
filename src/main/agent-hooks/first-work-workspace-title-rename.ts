import { humanizeBranchSlug } from '../../shared/source-control/ai/naming/branch-name-from-work'
import {
  generateBranchNameFromContext,
  resolveTextGenerationParams
} from '../text-generation/commit-message-text-generation'
import { resolveGenerationTarget } from './first-work-generation-target'
import { createResolvedTextGenerationParamsFence } from '../text-generation/text-generation-settings-fence'
import type { FirstWorkBranchRenameDeps } from './first-work-branch-rename'
import { retryFailedGeneration } from './first-work-generation-backoff'

export async function runFolderWorkspaceTitleAutoRename(
  worktreeId: string,
  prompt: string,
  assistantMessage: string | undefined,
  deps: FirstWorkBranchRenameDeps,
  stop: (reason: string, clearError?: boolean) => true,
  retry: (reason: string) => false
): Promise<boolean> {
  if (deps.isFolderWorkspaceWslMoveBlocked?.(worktreeId) === true) {
    return retry('a WSL move is taking the workspace')
  }
  if (deps.isPendingFirstAgentMessageRename?.(worktreeId) !== true) {
    return stop('folder workspace is not pending title rename', true)
  }
  const folderPath = deps.getFolderWorkspacePath?.(worktreeId)
  if (!folderPath) {
    return stop('folder workspace path unavailable')
  }

  const originalDisplayName = deps.getCurrentDisplayName(worktreeId)
  const settings = deps.getSettings()
  const resolvedParams = resolveTextGenerationParams(settings, 'local', 'branchName', null)
  if (!resolvedParams.ok) {
    deps.setRenameError(worktreeId, resolvedParams.error)
    return stop(`no generation agent: ${resolvedParams.error}`)
  }
  const ownerRevision = deps.getRenameOwnerRevision?.(worktreeId)
  const settingsCurrent = createResolvedTextGenerationParamsFence(
    () => deps.getSettings(),
    { settings, resolved: resolvedParams },
    'local',
    'branchName',
    null
  )
  const current = () =>
    settingsCurrent() &&
    deps.isPendingFirstAgentMessageRename?.(worktreeId) === true &&
    deps.getCurrentDisplayName(worktreeId) === originalDisplayName &&
    deps.getFolderWorkspacePath?.(worktreeId) === folderPath &&
    deps.isFolderWorkspaceWslMoveBlocked?.(worktreeId) !== true &&
    deps.getRenameOwnerRevision?.(worktreeId) === ownerRevision
  const target = await resolveGenerationTarget(folderPath, resolvedParams.params.agentId, deps, {
    params: resolvedParams.params,
    current,
    ownerId: worktreeId
  })
  if (!target) {
    deps.setRenameError(worktreeId, 'Could not prepare the workspace-name generation environment.')
    return retry('could not prepare generation environment')
  }

  try {
    const generated = await generateBranchNameFromContext(
      { firstPrompt: prompt, assistantMessage },
      resolvedParams.params,
      target
    )
    // Generation may outlive a manual rename or workspace removal.
    if (
      deps.isPendingFirstAgentMessageRename?.(worktreeId) !== true ||
      deps.getCurrentDisplayName(worktreeId) !== originalDisplayName
    ) {
      return stop('folder workspace changed during generation', true)
    }
    if (
      target.kind === 'local' &&
      target.request &&
      (!target.request.ownsResult() || (generated.success && !target.request.current()))
    ) {
      return retry('generation owner changed')
    }
    if (deps.isFolderWorkspaceWslMoveBlocked?.(worktreeId) === true) {
      return retry('a WSL move started during generation')
    }
    if (!generated.success) {
      return retryFailedGeneration(worktreeId, generated, deps, retry)
    }

    const newDisplayName = humanizeBranchSlug(generated.slug)
    deps.setDisplayName(worktreeId, newDisplayName)
    deps.setRenameError(worktreeId, null)
    deps.onRenamed(worktreeId)
    console.info(`[auto-branch-rename] renamed folder workspace title -> "${newDisplayName}"`)
    return true
  } finally {
    if (target.kind === 'local') {
      target.request?.finish()
    }
  }
}
