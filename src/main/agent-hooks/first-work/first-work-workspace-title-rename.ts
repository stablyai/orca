import { humanizeBranchSlug } from '../../../shared/source-control/ai/naming/branch-name-from-work'
import {
  generateBranchNameFromContext,
  resolveCommitMessageSettings as resolveTextGenerationParams
} from '../../text-generation/commit-message-text-generation'
import { resolveGenerationTarget } from './first-work-generation-target'
import type { FirstWorkBranchRenameDeps } from './first-work-branch-rename'
import {
  failedGenerationVerdict,
  resolveFirstWorkContext,
  type FirstWorkContextSource,
  type FirstWorkVerdictBuilders
} from './first-work-rename-verdicts'
import type { FirstWorkAttempt, FirstWorkRenameVerdict } from './first-work-rename-attempts'
import { WORKSPACE_NAME_ENVIRONMENT_FAILED_HEADLINE } from '../../../shared/worktree/branch-auto-rename-failure-headlines'

export async function runFolderWorkspaceTitleAutoRename(
  worktreeId: string,
  source: FirstWorkContextSource,
  deps: FirstWorkBranchRenameDeps,
  attempt: FirstWorkAttempt,
  verdicts: FirstWorkVerdictBuilders
): Promise<FirstWorkRenameVerdict> {
  const { stop, defer, failed } = verdicts
  if (deps.isFolderWorkspaceWslMoveBlocked?.(worktreeId) === true) {
    return defer('project-moving', 'a WSL move is taking the workspace')
  }
  if (deps.isPendingFirstAgentMessageRename?.(worktreeId) !== true) {
    return stop('already-named', 'folder workspace is not pending title rename', true)
  }
  const folderPath = deps.getFolderWorkspacePath?.(worktreeId)
  if (!folderPath) {
    return stop('unavailable', 'folder workspace path unavailable')
  }

  const originalDisplayName = deps.getCurrentDisplayName(worktreeId)
  const settings = deps.getSettings()
  const resolvedParams = resolveTextGenerationParams(settings, 'local', 'branchName', null)
  if (!resolvedParams.ok) {
    deps.setRenameError(worktreeId, resolvedParams.error)
    return failed(`no generation agent: ${resolvedParams.error}`, true)
  }
  const resolved = await resolveFirstWorkContext(source, attempt)
  if (resolved.kind === 'outcome') {
    return { outcome: resolved.outcome, settles: false }
  }
  const target = await resolveGenerationTarget(folderPath, resolvedParams.params.agentId, deps)
  if (!target) {
    deps.setRenameError(worktreeId, WORKSPACE_NAME_ENVIRONMENT_FAILED_HEADLINE)
    return failed('could not prepare generation environment', false)
  }

  // Target preparation awaits; a replaced workspace must not launch generation.
  attempt.assertIncarnation()
  const generated = await generateBranchNameFromContext(
    resolved.context,
    resolvedParams.params,
    target
  )
  // Generation may outlive a manual rename or workspace removal.
  if (
    deps.isPendingFirstAgentMessageRename?.(worktreeId) !== true ||
    deps.getCurrentDisplayName(worktreeId) !== originalDisplayName
  ) {
    return stop('already-named', 'folder workspace changed during generation', true)
  }
  if (deps.isFolderWorkspaceWslMoveBlocked?.(worktreeId) === true) {
    return defer('project-moving', 'a WSL move started during generation')
  }
  if (!generated.success) {
    return failedGenerationVerdict(worktreeId, generated, deps, verdicts)
  }
  if (!deps.getSettings().autoRenameBranchFromWork) {
    return {
      ...stop('setting-off', 'auto-rename was turned off during generation'),
      settles: false
    }
  }

  const newDisplayName = humanizeBranchSlug(generated.slug)
  deps.setDisplayName(worktreeId, newDisplayName)
  deps.setRenameError(worktreeId, null)
  deps.onRenamed(worktreeId)
  console.info(`[auto-branch-rename] renamed folder workspace title -> "${newDisplayName}"`)
  return { outcome: { kind: 'renamed' }, settles: true }
}
