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

// Resource scope is client + worktree + branch; connection state and generation only reconcile attempts.
export type PrSidebarObservation = {
  client: RpcClient | null
  worktreeId: string
  identity: string | null
  live: boolean
  latest: PrSidebarState
  loadSeq: number
  detailsSeq: number
  detailsInFlight: { seq: number; resourceKey: string } | null
  headSha: string | null
  // Last connection pair the reconciler saw; null until it samples after commit.
  observed: { state: ConnectionState; generation: number | undefined } | null
  // The query already asked of this observation, repeated on reconnect; null until first demand.
  demand: { includeDetails: boolean } | null
  // Latest committed load runner for that repeat.
  recover: (() => void) | null
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

// Keep HEAD out of identity: commits soft-refresh checks without clearing ready UI.
export function buildMobilePrSidebarIdentity(args: {
  worktreeId: string
  branch: string | null
}): string | null {
  return args.branch ? `${args.worktreeId}\u0000${args.branch}` : null
}

export function createSidebarObservation(input: PrSidebarControllerInput): PrSidebarObservation {
  return {
    client: input.client,
    worktreeId: input.worktreeId,
    identity: buildMobilePrSidebarIdentity(input),
    live: false,
    latest: { kind: 'hidden' },
    loadSeq: 0,
    detailsSeq: 0,
    detailsInFlight: null,
    headSha: input.headSha,
    observed: null,
    demand: null,
    recover: null
  }
}

export function createRepoProbe(worktreeId: string): RepoProbeObservation {
  return { owner: { worktreeId }, isGithubRepo: false, loaded: false }
}

// A real state/generation change retires the observation's attempts before the notification returns,
// and a connected one repeats the query already asked of it; accepted data stays.
export function subscribePrSidebarConnection(
  owner: PrSidebarObservation
): (() => void) | undefined {
  const client = owner.client
  if (!client) {
    return undefined
  }
  const reconcile = (state: ConnectionState) => {
    const generation = client.getGeneration?.()
    const observed = owner.observed
    if (observed?.state === state && Object.is(observed.generation, generation)) {
      return
    }
    owner.observed = { state, generation }
    // The first sample after commit only records; existing demand owns initial work.
    if (!observed) {
      return
    }
    owner.loadSeq += 1
    owner.detailsSeq += 1
    owner.detailsInFlight = null
    if (state === 'connected') {
      owner.recover?.()
    }
  }
  const stop = client.onStateChange(reconcile)
  reconcile(client.getState())
  return () => {
    stop()
    owner.observed = null
  }
}
