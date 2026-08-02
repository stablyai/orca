import { useEffect, useState } from 'react'
import type { HostedReviewCreationEligibility } from '../../../src/shared/hosted-review'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState } from '../transport/types'
import {
  fetchMobileHostedReviewEligibility,
  type MobileHostedReviewEligibilityInput
} from './mobile-hosted-review-service'
import type { MobileCreatePrEligibilityState } from './mobile-create-pr-action'

export type MobileHostedReviewEligibilityLoaderInput = {
  client: RpcClient | null
  connState: ConnectionState
  hostId: string
  worktreeId: string
  branch: string | null | undefined
  hasUpstream: boolean | undefined
  ahead: number | undefined
  behind: number | undefined
  hasUncommittedChanges: boolean
}

export type MobileHostedReviewEligibilityLoadKey = {
  identity: string
  fetch: string
}

export type MobileHostedReviewEligibilityLoadSnapshot = {
  key: MobileHostedReviewEligibilityLoadKey
  state: MobileCreatePrEligibilityState
}

export function buildMobileHostedReviewEligibilityLoadKey(
  input: Omit<MobileHostedReviewEligibilityLoaderInput, 'client' | 'connState'>
): MobileHostedReviewEligibilityLoadKey {
  const branch = input.branch ?? ''
  return {
    identity: `${input.hostId}\0${input.worktreeId}\0${branch}`,
    fetch: [
      input.hostId,
      input.worktreeId,
      branch,
      String(input.hasUpstream ?? ''),
      String(input.ahead ?? ''),
      String(input.behind ?? ''),
      String(input.hasUncommittedChanges)
    ].join('\0')
  }
}

export function shouldFetchMobileHostedReviewEligibility(
  input: Pick<MobileHostedReviewEligibilityLoaderInput, 'client' | 'connState' | 'branch'>
): boolean {
  return input.connState === 'connected' && input.client !== null && !!input.branch
}

export function eligibilityStateAfterMobileHostedReviewError(): MobileCreatePrEligibilityState {
  return { kind: 'error' }
}

export function renderedMobileHostedReviewEligibilityState(args: {
  snapshot: MobileHostedReviewEligibilityLoadSnapshot
  key: MobileHostedReviewEligibilityLoadKey
  shouldFetch: boolean
}): MobileCreatePrEligibilityState {
  if (!args.shouldFetch) {
    return { kind: 'idle' }
  }
  const { snapshot, key } = args
  if (snapshot.key.identity !== key.identity) {
    return { kind: 'loading', eligibility: null }
  }
  const { state } = snapshot
  if (snapshot.key.fetch !== key.fetch) {
    return {
      kind: 'loading',
      eligibility: state.kind === 'ready' || state.kind === 'loading' ? state.eligibility : null
    }
  }
  if (state.kind === 'idle') {
    return { kind: 'loading', eligibility: null }
  }
  return state
}

export function useMobileHostedReviewEligibility(
  input: MobileHostedReviewEligibilityLoaderInput
): MobileCreatePrEligibilityState {
  const {
    client,
    connState,
    hostId,
    worktreeId,
    branch,
    hasUpstream,
    ahead,
    behind,
    hasUncommittedChanges
  } = input
  const shouldFetch = shouldFetchMobileHostedReviewEligibility({ client, connState, branch })
  const key = buildMobileHostedReviewEligibilityLoadKey({
    hostId,
    worktreeId,
    branch,
    hasUpstream,
    ahead,
    behind,
    hasUncommittedChanges
  })
  const [snapshot, setSnapshot] = useState<MobileHostedReviewEligibilityLoadSnapshot>({
    key: { identity: '', fetch: '' },
    state: { kind: 'idle' }
  })

  useEffect(() => {
    let active = true

    if (!shouldFetch) {
      setSnapshot({ key, state: { kind: 'idle' } })
      return () => {
        active = false
      }
    }
    if (!client || !branch) {
      return () => {
        active = false
      }
    }

    setSnapshot((previous) => {
      const previousState = previous.state
      const eligibility =
        previous.key.identity === key.identity &&
        (previousState.kind === 'ready' || previousState.kind === 'loading')
          ? previousState.eligibility
          : null
      return { key, state: { kind: 'loading', eligibility } }
    })
    const requestInput: MobileHostedReviewEligibilityInput = {
      branch,
      hasUncommittedChanges,
      hasUpstream,
      ahead,
      behind
    }
    void fetchMobileHostedReviewEligibility(client, worktreeId, requestInput)
      .then((eligibility: HostedReviewCreationEligibility | null) => {
        if (!active) {
          return
        }
        if (!eligibility) {
          setSnapshot({ key, state: eligibilityStateAfterMobileHostedReviewError() })
          return
        }
        setSnapshot({ key, state: { kind: 'ready', eligibility } })
      })
      .catch(() => {
        if (active) {
          setSnapshot({ key, state: eligibilityStateAfterMobileHostedReviewError() })
        }
      })
    return () => {
      active = false
    }
  }, [
    ahead,
    behind,
    branch,
    client,
    connState,
    hasUncommittedChanges,
    hasUpstream,
    hostId,
    key.fetch,
    key.identity,
    shouldFetch,
    worktreeId
  ])

  // Why: gate on shouldFetch so a disconnect/client-loss hides a stale `ready`
  // snapshot in the same render, before the effect posts `idle` — otherwise the
  // Create PR button could stay enabled for one paint after the worktree is
  // no longer fetchable.
  return renderedMobileHostedReviewEligibilityState({
    snapshot,
    key,
    shouldFetch
  })
}
