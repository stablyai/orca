import { hasSameRepoRegistration } from '../persistence/tracking-repos/repo-registration-identity'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { gitExecFileAsync } from '../git/runner'
import type { getPullRequestDraftContext } from '../text-generation/pull-request-context'
import {
  mergeLegacyCommitMessageAiIntoSourceControlAi,
  type SourceControlAiSettingsInput,
  type ResolvedSourceControlAiGenerationParams
} from '../../shared/source-control-ai'
import type { SourceControlAiOperation } from '../../shared/source-control-ai-types'
import type { CommitMessageAgentRuntimeTarget } from '../text-generation/commit-message-agent-environment'
import type { CommitMessageGenerationTarget } from '../text-generation/commit-message-text-generation'
import type { LocalGenerationRequest } from '../text-generation/source-control-generation-lanes'
import type { PullRequestLinkedIssueMeta } from '../source-control/pull-request-linked-issue'
import {
  localGitOptionsForTarget,
  type RuntimeGitCommandHost,
  type RuntimeGitTarget
} from './runtime-git-command-target'

type PullRequestDraftGitExec = Parameters<typeof getPullRequestDraftContext>[0]

/** Runs the PR draft-context probes on a local target. */
export function pullRequestDraftGitExec(target: RuntimeGitTarget): PullRequestDraftGitExec {
  return (argv, options) =>
    gitExecFileAsync(argv, {
      cwd: target.worktree.path,
      ...localGitOptionsForTarget(target),
      ...(options?.maxBuffer === undefined ? {} : { maxBuffer: options.maxBuffer }),
      ...(options?.timeoutMs === undefined && options?.timeout === undefined
        ? {}
        : { timeout: options?.timeoutMs ?? options?.timeout }),
      admissionTier: 'interactive'
    })
}

export type RuntimeCommitMessageSettingsOverride = Partial<
  Pick<
    GlobalSettings,
    'commitMessageAi' | 'sourceControlAi' | 'agentCmdOverrides' | 'defaultTuiAgent'
  >
> & {
  commitMessageDiscoveryHostKey?: string
  sourceControlAiResolvedParams?: ResolvedSourceControlAiGenerationParams
}

export function getRuntimeGitGenerationSettings(
  settings: SourceControlAiSettingsInput,
  settingsOverride: RuntimeCommitMessageSettingsOverride | undefined,
  operation: SourceControlAiOperation
): SourceControlAiSettingsInput {
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
  env?: NodeJS.ProcessEnv,
  generationRequest?: LocalGenerationRequest
): Extract<CommitMessageGenerationTarget, { kind: 'local' }> {
  const wslDistro = localGitOptionsForTarget(target).wslDistro
  return {
    kind: 'local',
    cwd: target.worktree.path,
    ...(wslDistro ? { wslDistro } : {}),
    ...(env ? { env } : {}),
    ...(generationRequest ? { generationRequest } : {})
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

export async function runtimeGitGenerationTargetCurrent(
  host: RuntimeGitCommandHost,
  selector: string,
  target: RuntimeGitTarget
): Promise<boolean> {
  try {
    const latest = await host.resolveRuntimeGitTarget(selector)
    return (
      hasSameRepoRegistration(latest.repo, target.repo) &&
      latest.worktree.id === target.worktree.id &&
      latest.worktree.path === target.worktree.path &&
      latest.executionHostId === target.executionHostId &&
      JSON.stringify(localGitOptionsForTarget(latest)) ===
        JSON.stringify(localGitOptionsForTarget(target))
    )
  } catch {
    return false
  }
}
