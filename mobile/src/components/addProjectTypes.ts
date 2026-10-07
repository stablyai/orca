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
