import type { ExecutionHostId } from '../../../src/shared/execution-host'
import type { Repo as SharedRepo } from '../../../src/shared/repo-types'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import type { SetupHookTrust } from '../new-workspace/creation/setup-hook-trust'
import { resolveRepoBadgeColor } from '../../../src/shared/repo-badge-color'

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

/** Opened from a folder's empty state: that repo and name, created attached to the folder. */
export type NewWorktreeFolderLaunch = {
  repoId: string
  /** The repo's host, so a same-id copy on another host isn't picked. */
  executionHostId: ExecutionHostId
  name: string
  /** The folder's workspace key, `folder:<id>`. */
  parentWorkspace: string
  submit: NewWorktreeFolderSubmit
}

/** A folder's create, kept from admission until its outcome is known. */
export type NewWorktreeFolderSubmission = {
  settle: (outcome: 'created' | 'uncertain' | 'failed' | 'cancelled') => void
}

/** How the folder screen owns its composer's creates. */
export type NewWorktreeFolderSubmit = {
  /** Admits a create for the picked repo before anything is sent; null while another is out for it. */
  begin: (repo: MobileWorkspaceRepo) => NewWorktreeFolderSubmission | null
  /** False once the folder screen is left: the create runs on, without haptics. */
  presenting: () => boolean
}

export type NewWorktreeModalProps = {
  visible: boolean
  client: RpcClient | null
  /** The desktop's servers this phone can reach now; their repos are offered and created there. */
  serverClients?: ReadonlyMap<ExecutionHostId, RpcClient>
  hostId?: string
  /** The host list's badge labels, so a run target reads as its row does. */
  hostLabelById?: ReadonlyMap<ExecutionHostId, string>
  existingWorktreePaths?: readonly string[]
  existingWorktrees?: readonly { repoId: string; branch: string }[]
  /** A repo added from the phone moments ago; upserted and selected when the form opens. */
  preselectedRepo?: MobileWorkspaceRepo | null
  openExternalUrl: (url: string) => void
  /** `executionHost` names the server the workspace was created on; absent for the desktop's own. */
  onCreated: (
    worktreeId: string,
    name: string,
    warning?: string,
    executionHost?: ExecutionHostId
  ) => void
  onClose: () => void
  folderLaunch?: NewWorktreeFolderLaunch
}

export type SetupRunPolicy = 'ask' | 'run-by-default' | 'skip-by-default'

export type SetupHookDetails = {
  repoId: string
  command: string | null
  source: string | null
  trust: SetupHookTrust | null
  runPolicy: SetupRunPolicy
}

export function getMobileWorkspaceRepoBadgeColor(repo: MobileWorkspaceRepo | null): string {
  return resolveRepoBadgeColor(repo?.badgeColor)
}
