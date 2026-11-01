import { OrcaRuntimeWithGetStructuredAgentSessionCreateSupport } from './structured-session-create-support'
import type { RuntimeRepoSearchRefs } from '../../../shared/runtime-types'
import { DEFAULT_REPO_SEARCH_REFS_LIMIT } from '../orca-runtime-postlude'
import type { Repo } from '../../../shared/repo-types'
import type { GitAdmissionTier } from '../../git/command-runner/git-exec-options'
import {
  getLocalProjectGhExecOptions,
  type LocalProjectGhExecOptions
} from '../../project-runtime-git-options'
import {
  agentLaunchPlatformForScope,
  newWorktreeLaunchScope,
  resolveAgentLaunchRuntime,
  resolveStartupAgentLaunchRuntime
} from '../agent-launch-scope-runtime'
import type { TuiAgent } from '../../../shared/tui-agent'
import type { AgentLaunchRuntime } from '../../../shared/agent-launch-runtime'
import type { TerminalWorkspaceLaunchScope } from '../runtime-legacy-worker-terminal-recovery-types'
import { parseAppSshPtyId } from '../../../shared/ssh-pty-id'
import type {
  PtyProcessInspection,
  PtyProcessInspectionOptions
} from '../../providers/pty-process-inspection'

export abstract class OrcaRuntimeWithStructuredSessionLaunchRuntime extends OrcaRuntimeWithGetStructuredAgentSessionCreateSupport {
  async inspectTerminalProcess(
    terminalSelector: string,
    options?: PtyProcessInspectionOptions
  ): Promise<PtyProcessInspection> {
    const leaf = this.resolveLiveLeafForHandle(terminalSelector)
    if (!leaf?.ptyId || !this.ptyController) {
      throw new Error('terminal_gone')
    }
    if (this.ptyController.inspectProcess) {
      // Preserve one-argument unfenced calls; providers may use arity to select legacy versus fenced inspection.
      const inspection =
        options === undefined
          ? await this.ptyController.inspectProcess(leaf.ptyId)
          : await this.ptyController.inspectProcess(leaf.ptyId, options)
      const evidence = inspection.foregroundProcessEvidence
      // The runtime handle is the request identity on this wire; keep the
      // host-owned leaf PTY id out of the client-facing comparison.
      const relayPtyId = parseAppSshPtyId(leaf.ptyId)?.relayPtyId
      const evidenceBelongsToLeaf =
        evidence !== undefined && (evidence.ptyId === leaf.ptyId || evidence.ptyId === relayPtyId)
      return evidenceBelongsToLeaf
        ? { ...inspection, foregroundProcessEvidence: { ...evidence, ptyId: terminalSelector } }
        : inspection
    }
    const foregroundProcess = await this.ptyController.getForegroundProcess(leaf.ptyId)
    const hasChildProcesses = (await this.ptyController.hasChildProcesses?.(leaf.ptyId)) ?? false
    return { foregroundProcess, hasChildProcesses }
  }

  async searchRepoRefs(
    repoSelector: string,
    query: string,
    limit = DEFAULT_REPO_SEARCH_REFS_LIMIT,
    includeQualifiedRefs = true
  ): Promise<RuntimeRepoSearchRefs> {
    return this.repositoryRefQueries.search(repoSelector, query, limit, includeQualifiedRefs)
  }

  protected async resolveHostedReviewTarget(args: {
    repoSelector: string
    worktreeSelector?: string
  }): Promise<{ repo: Repo; repoPath: string }> {
    const repo = await this.resolveRepoSelector(args.repoSelector)
    if (!args.worktreeSelector) {
      return { repo, repoPath: repo.path }
    }

    const worktree = await this.resolveGitWorktreeSelector(args.worktreeSelector)
    if (worktree.repoId !== repo.id) {
      throw new Error('Access denied: worktree does not belong to repository')
    }
    return { repo, repoPath: worktree.path }
  }

  protected getHostedReviewExecutionOptions(
    repo: Repo,
    admissionTier?: GitAdmissionTier
  ):
    | { localGitExecOptions: LocalProjectGhExecOptions & { admissionTier?: GitAdmissionTier } }
    | undefined {
    const localGitOptions = {
      ...this.getLocalGitExecutionOptionArgs(repo)[0],
      ...(admissionTier && { admissionTier })
    }
    return Object.keys(localGitOptions).length > 0
      ? { localGitExecOptions: localGitOptions }
      : undefined
  }

  protected getLocalGitExecutionOptionArgs(repo: Repo): [] | [LocalProjectGhExecOptions] {
    const localGitOptions = getLocalProjectGhExecOptions(this.requireStore(), repo)
    return Object.keys(localGitOptions).length > 0 ? [localGitOptions] : []
  }

  protected getAgentLaunchPlatformForWorkspace(
    scope: Pick<TerminalWorkspaceLaunchScope, 'repo' | 'path'> & {
      connectionId?: string | null
    }
  ): NodeJS.Platform {
    // Orchestration passes a repo-only scope; the platform never reads its id or folder.
    return agentLaunchPlatformForScope(this.requireStore(), {
      id: '',
      folderWorkspace: null,
      ...scope,
      connectionId: scope.connectionId ?? null
    })
  }

  protected resolveAgentLaunchRuntime(
    scope: TerminalWorkspaceLaunchScope,
    agent: TuiAgent | undefined
  ): AgentLaunchRuntime {
    return resolveAgentLaunchRuntime(this.requireStore(), scope, undefined, agent)
  }

  protected resolveStartupAgentLaunchRuntime(
    repo: Repo,
    agent: TuiAgent,
    scope?: TerminalWorkspaceLaunchScope
  ): ReturnType<typeof resolveStartupAgentLaunchRuntime> {
    const store = this.requireStore()
    return resolveStartupAgentLaunchRuntime(
      store,
      scope ?? newWorktreeLaunchScope(repo, store.getSettings()),
      agent
    )
  }
}
