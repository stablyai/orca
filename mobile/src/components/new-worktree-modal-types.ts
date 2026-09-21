import type { Repo as SharedRepo } from '../../../src/shared/repo-types'
import type { RpcClient } from '../transport/rpc-client'
import type { SetupHookTrust } from '../tasks/setup-hook-trust'
import { repoColor } from '../worktree/repo-color'

export type MobileWorkspaceRepo = Pick<SharedRepo, 'id' | 'displayName' | 'path'> &
  Partial<
    Pick<
      SharedRepo,
      | 'badgeColor'
      | 'connectionId'
      | 'executionHostId'
      | 'kind'
      | 'upstream'
      | 'repoIcon'
      | 'gitRemoteIdentity'
    >
  >

export type NewWorktreeModalProps = {
  visible: boolean
  client: RpcClient | null
  hostId?: string
  existingWorktreePaths?: readonly string[]
  existingWorktrees?: readonly { repoId: string; branch: string }[]
  onCreated: (worktreeId: string, name: string) => void
  onClose: () => void
}

export type SetupRunPolicy = 'ask' | 'run-by-default' | 'skip-by-default'

export type RepoHooksResponse = {
  hooks: { scripts?: { setup?: string } } | null
  source: string | null
  setupRunPolicy?: SetupRunPolicy
  setupTrust?: SetupHookTrust
}

export type SetupHookDetails = {
  repoId: string
  command: string | null
  source: string | null
  trust: SetupHookTrust | null
  runPolicy: SetupRunPolicy
}

export function getMobileWorkspaceRepoBadgeColor(repo: MobileWorkspaceRepo | null): string {
  return repo?.badgeColor || repoColor(repo?.displayName ?? 'repository')
}
