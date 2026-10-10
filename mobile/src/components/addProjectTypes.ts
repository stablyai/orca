import type { RpcClient } from '../transport/rpc-client'
import type { MobileWorkspaceRepo } from './new-worktree-modal-types'

export type AddedRepo = {
  id: string
  path: string
  displayName: string
  connectionId?: string | null
  executionHostId?: string | null
}

export type FolderCandidate = { path: string; sshConnectionId: string | null; client: RpcClient }
export type AddProjectView =
  | 'start'
  | 'clone'
  | 'create'
  | 'addExisting'
  | 'confirmFolder'
  | 'pickDestination'
export type AddProjectHandoff = {
  repo: MobileWorkspaceRepo
  client: RpcClient | null
  openEpoch: number
}

export function toMobileRepo(repo: AddedRepo): MobileWorkspaceRepo {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the host receipt supplies the required mobile repo fields.
  return repo as MobileWorkspaceRepo
}

export const EMPTY_HOST_CAPABILITIES: readonly string[] = []
export const EMPTY_SSH_TARGETS: readonly {
  id: string
  label: string
  connected?: boolean
  connectionStatus?: string
}[] = []
export type AddProjectModalProps = {
  visible: boolean
  client: RpcClient | null
  onProjectAdded: (repo: MobileWorkspaceRepo) => void
  onClose: () => void
  hostCapabilities?: readonly string[]
  sshTargets?: readonly {
    id: string
    label: string
    connected?: boolean
    connectionStatus?: string
  }[]
}

export function createAddProjectScope(args: {
  client: RpcClient | null
  visible: boolean
  openEpoch: number
  selectedTargetId: string | null
  sshCapability: boolean
  selectedTargetAvailable: boolean
}) {
  return args
}
