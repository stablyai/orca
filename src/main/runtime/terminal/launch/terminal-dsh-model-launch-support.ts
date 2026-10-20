import { OrcaRuntimeWithAdoptTerminalOrphansFromInventory } from '../adoption/adopt-terminal-orphans-from-inventory'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import { newWorktreeLaunchScope, resolveAgentLaunchRuntime } from '../../agent-launch-scope-runtime'
import { parseWslUncPath } from '../../../../shared/wsl-paths'
import { prepareDshModelStartupInputs } from '../../../dsh/dsh-model-startup-plan'
import { resolveAgentStartupPlanInputs } from '../../../../shared/agent-startup-plan-inputs'

export abstract class OrcaRuntimeWithDshModelLaunchSupport extends OrcaRuntimeWithAdoptTerminalOrphansFromInventory {
  async assertOrchestrationDshModelLaunchSupport(target: {
    worktree?: string
    repo?: string
    model: string
    effort?: string
  }): Promise<void> {
    const store = this.requireStore()
    const repo = target.repo ? await this.resolveRepoSelector(target.repo) : null
    const workspace = repo
      ? newWorktreeLaunchScope(repo, store.getSettings())
      : await this.resolveTerminalWorkspaceLaunchScope(target.worktree!)
    if (
      workspace.connectionId ||
      (workspace.repo?.executionHostId && workspace.repo.executionHostId !== 'local')
    ) {
      throw new OrchestrationError(
        'capability_unsupported',
        'DSH launch options must be verified on the worker execution host.'
      )
    }
    const runtime = resolveAgentLaunchRuntime(store, workspace, undefined, 'dsh')
    await prepareDshModelStartupInputs({
      inputs: resolveAgentStartupPlanInputs({
        agent: 'dsh',
        settings: store.getSettings(),
        platform: runtime.platform,
        isRemote: false,
        shell: undefined,
        sessionOptions: {
          model: target.model,
          ...(target.effort ? { effort: target.effort } : {})
        }
      }),
      cwd: workspace.path,
      isWsl: Boolean(parseWslUncPath(workspace.path))
    })
  }
}
