import { humanizeBranchSlug } from '../../shared/branch-name-from-work'
import {
  generateBranchNameFromContext,
  resolveTextGenerationParams
} from '../text-generation/commit-message-text-generation'
import { resolveGenerationTarget } from './first-work-generation-target'
import type { FirstWorkBranchRenameDeps } from './first-work-branch-rename'

/**
 * Non-git folder workspaces have no branch to rename; the first-work hook
 * instead generates a workspace title. Shares the branch-name generation
 * machinery and the caller's stop/retry verdict semantics.
 */
export async function runFolderWorkspaceTitleAutoRename(
  worktreeId: string,
  prompt: string,
  assistantMessage: string | undefined,
  deps: FirstWorkBranchRenameDeps,
  stop: (reason: string, clearError?: boolean) => true,
  retry: (reason: string) => false
): Promise<boolean> {
  if (deps.isPendingFirstAgentMessageRename?.(worktreeId) !== true) {
    return stop('folder workspace is not pending title rename', true)
  }
  const folderPath = deps.getFolderWorkspacePath?.(worktreeId)
  if (!folderPath) {
    return stop('folder workspace path unavailable')
  }

  const settings = deps.getSettings()
  const resolvedParams = resolveTextGenerationParams(settings, 'local', 'branchName', null)
  if (!resolvedParams.ok) {
    deps.setRenameError(worktreeId, resolvedParams.error)
    return stop(`no generation agent: ${resolvedParams.error}`)
  }
  const target = await resolveGenerationTarget(
    folderPath,
    resolvedParams.params.agentId,
    null,
    deps
  )
  if (!target) {
    deps.setRenameError(worktreeId, 'Could not prepare the workspace-name generation environment.')
    return retry('could not prepare generation environment')
  }

  const generated = await generateBranchNameFromContext(
    { firstPrompt: prompt, assistantMessage },
    resolvedParams.params,
    target
  )
  if (!generated.success) {
    if (!generated.canceled) {
      deps.setRenameError(worktreeId, generated.error, generated.failureOutput ?? null)
    }
    return retry(`generation failed: ${generated.error}`)
  }

  const newDisplayName = humanizeBranchSlug(generated.slug)
  deps.setDisplayName(worktreeId, newDisplayName)
  deps.setRenameError(worktreeId, null)
  deps.onRenamed(worktreeId)
  console.info(`[auto-branch-rename] renamed folder workspace title -> "${newDisplayName}"`)
  return true
}
