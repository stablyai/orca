import { detectProjectLaunchContext } from '../../../preflight/workspace-agent-detection'
import type { RuntimeRepoSelector } from '../catalog/runtime-repo-selector'
import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import type { Repo } from '../../../../shared/repository/repo-types'
import type { RuntimeStore } from '../../construction/runtime-store-contract'
import { RuntimeWorktreeLineageOperations } from '../lineage/runtime-worktree-lineage-operations'
import { waitForPromiseWithSignal } from '../../../../shared/concurrency/abort-signal-reason'
export abstract class RuntimeProjectLaunchContext extends RuntimeWorktreeLineageOperations {
  protected abstract resolveRepoSelector(selector: RuntimeRepoSelector): Promise<Repo>

  abstract requireStore(): RuntimeStore

  async detectProjectLaunchContext(
    repoSelector: string,
    onlyTuiAgent?: TuiAgent,
    signal?: AbortSignal
  ) {
    const repo = await waitForPromiseWithSignal(this.resolveRepoSelector(repoSelector), signal)
    return detectProjectLaunchContext(this.requireStore(), repo, onlyTuiAgent, { signal })
  }
}
