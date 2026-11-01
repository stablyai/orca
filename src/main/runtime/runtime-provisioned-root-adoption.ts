/** Use the host-run recipe root as main workspace, as for direct SSH adoption; create no linked worktree. */
import type { Repo } from '../../shared/repo-types'
import type { CreateWorktreeResult } from '../../shared/worktree/create-types'
import type { GitWorktreeInfo, Worktree } from '../../shared/worktree/types'
import { getRepoSshConnectionId } from '../../shared/execution-host'
import { isFolderRepo } from '../../shared/repo-kind'
import {
  buildProvisionedRootMeta,
  provisionedRootPathsEqual,
  verifyProvisionedRootCheckout,
  type ProvisionedRootMetaStore,
  type ProvisionedRootRequest
} from '../provisioned-root-checkout'
import { gitExecFileAsync } from '../git/runner'
import type { RuntimeStore } from './runtime-store-contract'
import { assertWslMoveRepoWritable } from '../persistence/moving-wsl-projects/wsl-move-scope-guard'
import { hostWorktreeTargetForRepo } from '../persistence/host-qualified-worktree-meta'

export type RuntimeProvisionedRootRequest = ProvisionedRootRequest & { expectedPath: string }

export type RuntimeProvisionedRootPorts = {
  store: ProvisionedRootMetaStore & Pick<RuntimeStore, 'getRepo' | 'setWorktreeMeta'>
  resolveRepo: (selector: string) => Promise<Repo>
  listWorktrees: (repoPath: string) => Promise<GitWorktreeInfo[]>
  isSparseCheckoutEnabled: (checkoutPath: string) => Promise<boolean>
  invalidateScan: (repoId: string) => void
  notifyChanged: (repoId: string) => void
  showWorktree: (selector: string) => Promise<Worktree>
}

export async function adoptRuntimeProvisionedRoot(
  repoSelector: string,
  request: RuntimeProvisionedRootRequest,
  ports: RuntimeProvisionedRootPorts
): Promise<CreateWorktreeResult> {
  if (request.sparseCheckout) {
    throw new Error('Provisioned-root recipes do not support sparse checkout.')
  }
  const repo = await ports.resolveRepo(repoSelector)
  if (isFolderRepo(repo) || getRepoSshConnectionId(repo)) {
    throw new Error('Provisioned-root adoption requires a Git checkout on this host.')
  }
  assertWslMoveRepoWritable(ports.store, repo)
  if (!provisionedRootPathsEqual(repo.path, request.expectedPath)) {
    throw new Error('The recipe projectRoot does not match the imported Git checkout root.')
  }
  const [worktrees, sparseCheckoutEnabled] = await Promise.all([
    ports.listWorktrees(repo.path),
    ports.isSparseCheckoutEnabled(repo.path)
  ])
  const gitWorktree = verifyProvisionedRootCheckout({
    worktrees,
    sparseCheckoutEnabled,
    projectRoot: request.expectedPath,
    request
  })
  const worktreeId = `${repo.id}::${gitWorktree.path}`
  ports.store.setWorktreeMeta(
    hostWorktreeTargetForRepo(worktreeId, repo),
    buildProvisionedRootMeta(ports.store, repo, request, {
      branchName: gitWorktree.branch.replace(/^refs\/heads\//, ''),
      now: Date.now(),
      source: 'runtime'
    })
  )
  ports.invalidateScan(repo.id)
  ports.notifyChanged(repo.id)
  return { worktree: await ports.showWorktree(`id:${worktreeId}`) }
}

export async function readLocalSparseCheckoutEnabled(checkoutPath: string): Promise<boolean> {
  const { stdout } = await gitExecFileAsync(
    ['config', '--bool', '--get', '--default=false', 'core.sparseCheckout'],
    { cwd: checkoutPath }
  )
  return stdout.trim() === 'true'
}
