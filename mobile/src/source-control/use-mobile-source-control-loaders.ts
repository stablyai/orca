import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react'
import { View } from 'react-native'
import type { RpcClient } from '../transport/rpc-client'
import {
  GenerationScopedRequestOwner,
  type RequestScope
} from '../transport/generation-scoped-request-owner'
import { refusedRpcMessageOrFallback } from '../transport/rpc-refusal-message'
import type { ConnectionState } from '../transport/types'
import { resolveMobileBranchCompareBaseRef } from './mobile-branch-base-ref'
import { gitBranchCompareRead, gitStatusHostPayloadRead } from './mobile-git-read-operations'
import {
  isMobileGitTransientRefreshError,
  isMobileGitUnavailableReply,
  readMobileGitRefusal
} from './mobile-git-status'
import type { MobileGitBranchCompareReply } from './git-compare-reply-schema'
import {
  SELECTOR_RETRY_COUNT,
  SELECTOR_RETRY_DELAY_MS,
  wait,
  type LoadStatusOptions,
  type MobileBranchCompareState,
  type ScreenState,
  type StatusLoadInFlight
} from './mobile-source-control-screen-state'

type Params = {
  client: RpcClient | null
  connState: ConnectionState
  statusIdentityKey: string
  worktreeId: string
  setActionError: (message: string | null) => void
  onStatusLoadSuccess?: () => void
}

/** The compare is the whole worktree against its base, so its request carries no further parameters. */
type BranchCompareParameters = Readonly<Record<string, never>>
const WHOLE_WORKTREE: BranchCompareParameters = {}

/**
 * Every end one compare attempt can reach, its failures included. The attempt returns its outcome
 * instead of writing it, so the screen is written in exactly one place: past the owner's `commit`.
 */
type BranchCompareOutcome =
  | { readonly kind: 'ready'; readonly result: MobileGitBranchCompareReply }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'failed'; readonly message: string }

/** Total by construction: a throw here would reach a caller that only ever voids this load. */
async function readBranchCompareOutcome(
  client: RpcClient,
  worktreeId: string
): Promise<BranchCompareOutcome> {
  try {
    const baseRef = await resolveMobileBranchCompareBaseRef(client, worktreeId)
    if (!baseRef) {
      return { kind: 'failed', message: 'Unable to resolve the base branch for comparison.' }
    }
    const reply = await gitBranchCompareRead.request(client, {
      worktree: `id:${worktreeId}`,
      baseRef
    })
    // Why the raw refusal: a host that does not offer git to mobile is a capability gap this
    // screen degrades on, and no acceptance policy carries the code and message through.
    if (isMobileGitUnavailableReply(reply)) {
      return { kind: 'unavailable' }
    }
    try {
      return { kind: 'ready', result: gitBranchCompareRead.interpret(reply) }
    } catch (error) {
      return {
        kind: 'failed',
        message: refusedRpcMessageOrFallback(error, 'Unable to load committed changes')
      }
    }
  } catch (err) {
    return {
      kind: 'failed',
      message: err instanceof Error ? err.message : 'Unable to load committed changes'
    }
  }
}

/** What an outcome leaves on screen, given what this caller wants kept when the attempt fails. */
function nextBranchCompareState(
  outcome: BranchCompareOutcome,
  previous: MobileBranchCompareState,
  preserveReadyOnFailure: boolean
): MobileBranchCompareState {
  if (outcome.kind === 'ready') {
    return { kind: 'ready', result: outcome.result }
  }
  // Why: wiping a prior ready compare to idle makes Changes say "No Changes" even when commits
  // still exist (e.g. after abort-merge refresh).
  if (preserveReadyOnFailure && previous.kind === 'ready') {
    return previous
  }
  return outcome.kind === 'unavailable'
    ? { kind: 'idle' }
    : { kind: 'error', message: outcome.message }
}

export type MobileSourceControlLoaders = {
  screenState: ScreenState
  setScreenState: (next: ScreenState | ((prev: ScreenState) => ScreenState)) => void
  branchCompareState: MobileBranchCompareState
  setBranchCompareState: (
    next: MobileBranchCompareState | ((prev: MobileBranchCompareState) => MobileBranchCompareState)
  ) => void
  mountedRef: MutableRefObject<boolean>
  setRootRef: (node: View | null) => void
  loadStatus: (options?: LoadStatusOptions) => Promise<boolean>
}

// Owns git.status / git.branchCompare loading, the load-generation guards, and
// the mount ref so the giant state hook stays under the line limit.
export function useMobileSourceControlLoaders(params: Params): MobileSourceControlLoaders {
  const { client, connState, statusIdentityKey, worktreeId, setActionError, onStatusLoadSuccess } =
    params
  const [screenState, setScreenState] = useState<ScreenState>({ kind: 'loading' })
  const [branchCompareState, setBranchCompareState] = useState<MobileBranchCompareState>({
    kind: 'idle'
  })
  const currentStatusIdentityRef = useRef('')
  const loadGenerationRef = useRef(0)
  const mountedRef = useRef(true)
  const statusLoadInFlightRef = useRef<StatusLoadInFlight | null>(null)
  const branchCompare = useRef(
    new GenerationScopedRequestOwner<BranchCompareParameters, BranchCompareOutcome>()
  ).current
  // Why: the same route can be reused for another worktree/host (identity change);
  // a kept-on-failure `ready` state would otherwise show the previous worktree's
  // data until the fresh load resolves. Reset to loading in the render phase (the
  // React "adjust state on prop change" pattern) before the new load runs.
  const lastResetIdentityRef = useRef(statusIdentityKey)
  if (lastResetIdentityRef.current !== statusIdentityKey) {
    lastResetIdentityRef.current = statusIdentityKey
    // Retire here rather than leaving it to the next load's scope: that load only starts once the
    // fresh status returns, and an in-flight compare would publish the old worktree's commits first.
    branchCompare.reset()
    setScreenState({ kind: 'loading' })
    setBranchCompareState({ kind: 'idle' })
  }
  currentStatusIdentityRef.current = statusIdentityKey

  const setRootRef = useCallback(
    (node: View | null): void => {
      if (node !== null) {
        mountedRef.current = true
        return
      }
      // Why: source-control RPC loads can outlive the route; invalidate pending
      // writes when the screen detaches without a passive cleanup-only Effect.
      mountedRef.current = false
      loadGenerationRef.current += 1
      branchCompare.reset()
    },
    [branchCompare]
  )

  const loadBranchCompare = useCallback(
    async (options?: { preserveReadyOnFailure?: boolean }) => {
      // A compare is a refresh, so nothing it holds is reusable and no attempt may share another's
      // reply: retiring first is what makes the newest attempt the only one that can still publish.
      branchCompare.reset()
      if (!worktreeId || !client || connState !== 'connected') {
        if (mountedRef.current) {
          setBranchCompareState({ kind: 'idle' })
        }
        return false
      }
      // What retires a compare: this host, this route identity, this workspace. The route identity
      // is in it as well as in the render-phase retire, so a scope the owner has not seen still
      // retires on its own if a load ever reaches it before that block does.
      const scope: RequestScope = [client, statusIdentityKey, worktreeId]

      setBranchCompareState((prev) => (prev.kind === 'ready' ? prev : { kind: 'loading' }))
      const loaded = await branchCompare.load(scope, WHOLE_WORKTREE, () =>
        readBranchCompareOutcome(client, worktreeId)
      )
      // The mount latch is not the owner's to keep: a detached route has no screen to publish to,
      // which is a fact about the view, not about which reply is current.
      if (!loaded || !mountedRef.current) {
        return false
      }
      if (branchCompare.commit(loaded.lease, loaded.value) !== 'committed') {
        return false
      }
      const outcome = loaded.value
      setBranchCompareState((prev) =>
        nextBranchCompareState(outcome, prev, options?.preserveReadyOnFailure === true)
      )
      return outcome.kind === 'ready'
    },
    [branchCompare, client, connState, statusIdentityKey, worktreeId]
  )

  const loadStatus = useCallback(
    async (options?: LoadStatusOptions) => {
      const loadKey = statusIdentityKey
      const inFlight = statusLoadInFlightRef.current
      if (inFlight && !options?.force && inFlight.key === loadKey && inFlight.client === client) {
        return await inFlight.promise
      }

      const loadPromise = (async () => {
        const generation = loadGenerationRef.current + 1
        loadGenerationRef.current = generation
        const isCurrentLoad = () =>
          mountedRef.current &&
          loadGenerationRef.current === generation &&
          currentStatusIdentityRef.current === loadKey
        if (!worktreeId) {
          if (isCurrentLoad()) {
            setScreenState({ kind: 'loading' })
          }
          return false
        }
        if (!client || connState !== 'connected') {
          if (isCurrentLoad()) {
            setScreenState({
              kind: 'error',
              message:
                connState === 'connected' ? 'Connecting to desktop...' : 'Waiting for desktop...'
            })
          }
          return false
        }
        if (!isCurrentLoad()) {
          return false
        }
        setScreenState((prev) => (prev.kind === 'ready' ? prev : { kind: 'loading' }))
        try {
          for (let attempt = 0; attempt <= SELECTOR_RETRY_COUNT; attempt += 1) {
            const reply = await gitStatusHostPayloadRead.request(client, {
              worktree: `id:${worktreeId}`
            })
            if (!isCurrentLoad()) {
              return false
            }
            // Why the raw refusal: the retry and capability routes below are decided by the
            // refusal's code, which no acceptance policy carries through.
            const refusal = readMobileGitRefusal(reply)
            if (!refusal) {
              const result = gitStatusHostPayloadRead.interpret(reply)
              setScreenState({ kind: 'ready', status: result })
              void loadBranchCompare({ preserveReadyOnFailure: true })
              if (options?.clearActionErrorOnSuccess !== false) {
                setActionError(null)
              }
              // Why: recovery prompts are based on a specific failed commit
              // snapshot; a fresh status means that snapshot may be stale.
              onStatusLoadSuccess?.()
              return true
            }
            if (isMobileGitUnavailableReply(reply)) {
              setScreenState({
                kind: 'unavailable',
                message: 'Update Orca desktop to use Source Control on mobile.'
              })
              return false
            }
            const shouldRetry =
              refusal.code === 'selector_not_found' ||
              isMobileGitTransientRefreshError(refusal.code, refusal.message)
            if (shouldRetry && attempt < SELECTOR_RETRY_COUNT) {
              await wait(SELECTOR_RETRY_DELAY_MS)
              if (!isCurrentLoad()) {
                return false
              }
              continue
            }
            throw new Error(refusal.message || 'Unable to load source control')
          }
        } catch (err) {
          if (!isCurrentLoad()) {
            return false
          }
          const message = err instanceof Error ? err.message : 'Unable to load source control'
          setScreenState((prev) => {
            // Why: git mutations can succeed while the immediate status refresh
            // races a desktop abort; keep the last good screen instead of flashing
            // a full-screen error that Retry fixes a moment later.
            if (options?.preserveReadyOnFailure && prev.kind === 'ready') {
              return prev
            }
            return { kind: 'error', message }
          })
          return false
        }
        return false
      })()

      statusLoadInFlightRef.current = { key: loadKey, client, promise: loadPromise }
      try {
        return await loadPromise
      } finally {
        if (statusLoadInFlightRef.current?.promise === loadPromise) {
          statusLoadInFlightRef.current = null
        }
      }
    },
    [
      client,
      connState,
      loadBranchCompare,
      onStatusLoadSuccess,
      statusIdentityKey,
      worktreeId,
      setActionError
    ]
  )

  useEffect(() => {
    void loadStatus()
  }, [loadStatus])

  return {
    screenState,
    setScreenState,
    branchCompareState,
    setBranchCompareState,
    mountedRef,
    setRootRef,
    loadStatus
  }
}
