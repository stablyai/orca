import type { GlobalSettings } from '../../shared/global-settings-types'
import {
  mergeLegacyCommitMessageAiIntoSourceControlAi,
  type ResolvedSourceControlAiGenerationParams
} from '../../shared/source-control-ai'
import type { SourceControlAiOperation } from '../../shared/source-control-ai-types'
import type { CommitMessageAgentRuntimeTarget } from '../text-generation/commit-message-agent-environment'
import type { CommitMessageGenerationTarget } from '../text-generation/commit-message-text-generation'
import type { PullRequestLinkedIssueMeta } from '../source-control/pull-request-linked-issue'
import {
  localGitOptionsForTarget,
  type RuntimeGitCommandHost,
  type RuntimeGitTarget
} from './runtime-git-command-target'

export type RuntimeCommitMessageSettingsOverride = Partial<
  Pick<GlobalSettings, 'commitMessageAi' | 'sourceControlAi' | 'agentCmdOverrides'>
> & {
  commitMessageDiscoveryHostKey?: string
  sourceControlAiResolvedParams?: ResolvedSourceControlAiGenerationParams
}

export function getRuntimeGitGenerationSettings(
  settings: GlobalSettings,
  settingsOverride: RuntimeCommitMessageSettingsOverride | undefined,
  operation: SourceControlAiOperation
): GlobalSettings {
  const mergedSettings = { ...settings, ...settingsOverride }
  if (
    settingsOverride?.commitMessageAi !== undefined &&
    settingsOverride.sourceControlAi === undefined
  ) {
    mergedSettings.sourceControlAi = mergeLegacyCommitMessageAiIntoSourceControlAi(
      settings.sourceControlAi,
      settingsOverride.commitMessageAi,
      { pullRequestInstructionsFromLegacy: operation === 'pullRequest' }
    )
  }
  return mergedSettings
}

export function localAgentRuntimeTargetForTarget(
  target: RuntimeGitTarget
): CommitMessageAgentRuntimeTarget {
  const wslDistro = localGitOptionsForTarget(target).wslDistro
  return wslDistro ? { runtime: 'wsl', wslDistro } : { runtime: 'host' }
}

export function localTextGenerationTargetForTarget(
  target: RuntimeGitTarget,
  env?: NodeJS.ProcessEnv
): Extract<CommitMessageGenerationTarget, { kind: 'local' }> {
  const wslDistro = localGitOptionsForTarget(target).wslDistro
  return {
    kind: 'local',
    cwd: target.worktree.path,
    ...(wslDistro ? { wslDistro } : {}),
    ...(env ? { env } : {})
  }
}

export function linkedIssueForTarget(
  host: RuntimeGitCommandHost,
  target: RuntimeGitTarget
): number | null | undefined {
  const live = host.getWorktreeLinkedIssue?.(target.worktree.id)
  // Why: `undefined` means the host could not answer, not "unlinked".
  return live === undefined ? target.worktree.linkedIssue : live
}

export function linkedIssueMetaForTarget(
  host: RuntimeGitCommandHost,
  target: RuntimeGitTarget
): PullRequestLinkedIssueMeta | null {
  const live = host.getWorktreeLinkedIssueMeta?.(target.worktree.id)
  if (live !== undefined) {
    return live
  }
  const liveGitHubIssue = host.getWorktreeLinkedIssue?.(target.worktree.id)
  return {
    linkedIssue: liveGitHubIssue === undefined ? target.worktree.linkedIssue : liveGitHubIssue,
    linkedGitLabIssue: target.worktree.linkedGitLabIssue,
    linkedWorkItem: target.worktree.linkedWorkItem
  }
}
