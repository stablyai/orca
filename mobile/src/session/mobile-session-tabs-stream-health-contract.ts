import type { RpcClient } from '../transport/rpc-client'
import type { RpcFailure } from '../transport/types'

export type SessionTabsApplyOutcome<Tab> =
  | { accepted: false }
  | { accepted: true; effectiveTabs: readonly Tab[]; applicationRevision?: number }

export type SessionTabsStreamSource = 'list' | 'stream'

export type SessionTabsStreamHealth = 'probing' | 'live' | 'degraded'

export type SessionTabsRequestOwner = {
  generation: number
  barrier: number
  requirement: number
  applicationRevision: number
}

export type SessionTabsRequestCohort = {
  promise: Promise<void>
  resolve: () => void
  retry: boolean
}

export type SessionTabsStreamHealthOptions<Result, Tab> = {
  client?: RpcClient
  scope?: string
  requestSnapshot?: () => Promise<Result>
  getGeneration?: () => number
  apply: (result: Result) => SessionTabsApplyOutcome<Tab>
  consumeAccepted: (
    result: Result,
    effectiveTabs: readonly Tab[],
    source: SessionTabsStreamSource
  ) => void
  hasRecoveryNeed: () => boolean
  allowRecoveryPoll?: () => boolean
  getApplicationRevision?: () => number
  onFetchStarted?: () => void
  onFetchSucceeded?: (result: Result) => void
  onFetchFailed?: (failure: RpcFailure) => void
  onFetchErrored?: (error: unknown) => void
}

export type SessionTabsStreamSubscription = {
  listener: (payload: unknown) => void
  cancel: () => void
}

export type GenerationRpcClient = RpcClient & { getGeneration?: () => number }
