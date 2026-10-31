import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState } from '../transport/types'
import type { PrSidebarState } from './mobile-pr-sidebar-state'

export type PrSidebarControllerInput = {
  client: RpcClient | null
  connState: ConnectionState
  worktreeId: string
  branch: string | null
  headSha: string | null
}

export type PrSidebarObservation = {
  client: RpcClient | null
  generation: number | undefined
  worktreeId: string
  identity: string | null
  live: boolean
  latest: PrSidebarState
  loadSeq: number
  detailsSeq: number
  detailsInFlight: { seq: number; resourceKey: string } | null
  headSha: string | null
}

export type RepoProbeObservation = {
  owner: { worktreeId: string }
  isGithubRepo: boolean
  loaded: boolean
}

export type PrSidebarSelection = {
  owner: PrSidebarObservation
  snapshot: PrSidebarState
  probe: RepoProbeObservation
}
