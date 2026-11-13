import type { RuntimeStore } from '../../construction/runtime-store-contract'
import type { ResolvedWorktree } from './runtime-worktree-path-identity'
import type { Repo } from '../../../../shared/repo-types'
import type { WitnessedRuntimeWorktreeScan } from './runtime-witnessed-worktree-scan'
import type { ExecutionHostId } from '../../../../shared/execution-host'

export type RuntimeManagedWorktreeQueryDependencies = {
  getStore(): RuntimeStore | null
  listResolved(): Promise<ResolvedWorktree[]>
  resolveRepo(selector: string): Promise<Repo>
  selectRepos(selector: string): Repo[]
  scanRepo(repo: Repo): Promise<WitnessedRuntimeWorktreeScan>
  /** Hosts this runtime has repos or workspaces on, so a host with no rows is still named. */
  listKnownHostIds(): Iterable<ExecutionHostId>
}
