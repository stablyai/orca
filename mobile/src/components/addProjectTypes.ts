import type { RpcClient } from '../transport/rpc-client'

export type AddedRepo = {
  id: string
  path: string
  displayName: string
  connectionId?: string | null
  executionHostId?: string | null
}

export type FolderCandidate = { path: string; sshConnectionId: string | null; client: RpcClient }
