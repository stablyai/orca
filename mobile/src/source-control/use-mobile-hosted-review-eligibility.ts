import { useEffect, useRef, useState } from 'react'
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

export function buildMobileHostedReviewEligibilityLoadKey(
  input: Omit<MobileHostedReviewEligibilityLoaderInput, 'client' | 'connState'>
): MobileHostedReviewEligibilityLoadKey {
  const branch = input.branch ?? ''
  return {
    identity: `${input.worktreeId}\0${branch}`,
    fetch: [
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

export function acceptsMobileHostedReviewEligibilityLoad(args: {
  generation: number
  currentGeneration: number
  identity: string
  currentIdentity: string
}): boolean {
  return args.generation === args.currentGeneration && args.identity === args.currentIdentity
}

export function eligibilityStateAfterMobileHostedReviewError(): MobileCreatePrEligibilityState {
  return { kind: 'error' }
}

export function useMobileHostedReviewEligibility(
  input: MobileHostedReviewEligibilityLoaderInput
): MobileCreatePrEligibilityState {
  const {
    client,
    connState,
    worktreeId,
    branch,
    hasUpstream,
    ahead,
    behind,
    hasUncommittedChanges
  } = input
  const shouldFetch = shouldFetchMobileHostedReviewEligibility({ client, connState, branch })
  const [state, setState] = useState<MobileCreatePrEligibilityState>({ kind: 'idle' })
  const generationRef = useRef(0)
  const currentIdentityRef = useRef('')
  const lastResetIdentityRef = useRef('')
  const key = buildMobileHostedReviewEligibilityLoadKey({
    worktreeId,
    branch,
    hasUpstream,
    ahead,
    behind,
    hasUncommittedChanges
  })

  if (lastResetIdentityRef.current !== key.identity) {
    lastResetIdentityRef.current = key.identity
    setState({ kind: 'idle' })
  }
  currentIdentityRef.current = key.identity

  useEffect(() => {
    const generation = generationRef.current + 1
    generationRef.current = generation
    const isCurrent = () =>
      acceptsMobileHostedReviewEligibilityLoad({
        generation,
        currentGeneration: generationRef.current,
        identity: key.identity,
        currentIdentity: currentIdentityRef.current
      })

    if (!shouldFetch) {
      if (isCurrent()) {
        setState({ kind: 'idle' })
      }
      return
    }
    if (!client || !branch) {
      return
    }

    setState((prev) => ({
      kind: 'loading',
      eligibility: prev.kind === 'ready' ? prev.eligibility : null
    }))
    const requestInput: MobileHostedReviewEligibilityInput = {
      branch,
      hasUncommittedChanges,
      hasUpstream,
      ahead,
      behind
    }
    void fetchMobileHostedReviewEligibility(client, worktreeId, requestInput)
      .then((eligibility: HostedReviewCreationEligibility | null) => {
        if (!isCurrent()) {
          return
        }
        if (!eligibility) {
          setState({ kind: 'error' })
          return
        }
        setState({ kind: 'ready', eligibility })
      })
      .catch(() => {
        if (isCurrent()) {
          setState(eligibilityStateAfterMobileHostedReviewError())
        }
      })
  }, [
    ahead,
    behind,
    branch,
    client,
    connState,
    hasUncommittedChanges,
    hasUpstream,
    key.fetch,
    key.identity,
    shouldFetch,
    worktreeId
  ])

  // Why: gate on shouldFetch so a disconnect/client-loss hides a stale `ready`
  // snapshot in the same render, before the effect posts `idle` — otherwise the
  // Create PR button could stay enabled for one paint after the worktree is
  // no longer fetchable.
  return shouldFetch ? state : { kind: 'idle' }
}
