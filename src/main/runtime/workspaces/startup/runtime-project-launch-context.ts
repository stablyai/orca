import { detectProjectLaunchContext } from '../../../preflight/workspace-agent-detection'
import type { RuntimeRepoSelector } from '../catalog/runtime-repo-selector'
import type { Repo } from '../../../../shared/repo-types'
import type { RuntimeStore } from '../../construction/runtime-store-contract'
import { RuntimeWorktreeLineageOperations } from '../lineage/runtime-worktree-lineage-operations'
export abstract class RuntimeProjectLaunchContext extends RuntimeWorktreeLineageOperations {
  protected abstract resolveRepoSelector(selector: RuntimeRepoSelector): Promise<Repo>

  abstract requireStore(): RuntimeStore

  async detectProjectLaunchContext(repoSelector: string) {
    const repo = await this.resolveRepoSelector(repoSelector)
    return detectProjectLaunchContext(this.requireStore(), repo)
  }
}
