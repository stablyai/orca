import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react'
import { View } from 'react-native'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState, RpcSuccess } from '../transport/types'
import { resolveMobileBranchCompareBaseRef } from './mobile-branch-base-ref'
import {
  isMobileGitUnavailable,
  isMobileGitTransientRefreshError,
  type MobileGitStatusResult
} from './mobile-git-status'
import { type MobileGitBranchCompareResult } from './mobile-branch-compare'
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
  const { client, connState, statusIdentityKey, worktreeId, setActionError } = params
  const [screenState, setScreenState] = useState<ScreenState>({ kind: 'loading' })
  const [branchCompareState, setBranchCompareState] = useState<MobileBranchCompareState>({
    kind: 'idle'
  })
  const currentStatusIdentityRef = useRef('')
  const currentBranchCompareIdentityRef = useRef('')
  const loadGenerationRef = useRef(0)
  const branchCompareGenerationRef = useRef(0)
  const mountedRef = useRef(true)
  const statusLoadInFlightRef = useRef<StatusLoadInFlight | null>(null)
  // Why: the same route can be reused for another worktree/host (identity change);
  // a kept-on-failure `ready` state would otherwise show the previous worktree's
  // data until the fresh load resolves. Reset to loading in the render phase (the
  // React "adjust state on prop change" pattern) before the new load runs.
  const lastResetIdentityRef = useRef(statusIdentityKey)
  if (lastResetIdentityRef.current !== statusIdentityKey) {
    lastResetIdentityRef.current = statusIdentityKey
    setScreenState({ kind: 'loading' })
    setBranchCompareState({ kind: 'idle' })
  }
  currentStatusIdentityRef.current = statusIdentityKey
  currentBranchCompareIdentityRef.current = statusIdentityKey

  const setRootRef = useCallback((node: View | null): void => {
    if (node !== null) {
      mountedRef.current = true
      return
    }
    // Why: source-control RPC loads can outlive the route; invalidate pending
    // writes when the screen detaches without a passive cleanup-only Effect.
    mountedRef.current = false
    loadGenerationRef.current += 1
    branchCompareGenerationRef.current += 1
  }, [])

  const loadBranchCompare = useCallback(
    async (options?: { preserveReadyOnFailure?: boolean }) => {
      const loadKey = statusIdentityKey
      const generation = branchCompareGenerationRef.current + 1
      branchCompareGenerationRef.current = generation
      const isCurrentLoad = () =>
        mountedRef.current &&
        branchCompareGenerationRef.current === generation &&
        currentBranchCompareIdentityRef.current === loadKey

      if (!worktreeId || !client || connState !== 'connected') {
        if (isCurrentLoad()) {
          setBranchCompareState({ kind: 'idle' })
        }
        return false
      }

      setBranchCompareState((prev) => (prev.kind === 'ready' ? prev : { kind: 'loading' }))
      try {
        const baseRef = await resolveMobileBranchCompareBaseRef(client, worktreeId)
        if (!isCurrentLoad()) {
          return false
        }
        if (!baseRef) {
          setBranchCompareState({ kind: 'idle' })
          return true
        }
        const response = await client.sendRequest('git.branchCompare', {
          worktree: `id:${worktreeId}`,
          baseRef
        })
        if (!isCurrentLoad()) {
          return false
        }
        if (!response.ok) {
          if (isMobileGitUnavailable(response.error?.code, response.error?.message)) {
            setBranchCompareState({ kind: 'idle' })
            return false
          }
          throw new Error(response.error?.message || 'Unable to load committed changes')
        }
        setBranchCompareState({
          kind: 'ready',
          result: (response as RpcSuccess).result as MobileGitBranchCompareResult
        })
        return true
      } catch (err) {
        if (!isCurrentLoad()) {
          return false
        }
        const message = err instanceof Error ? err.message : 'Unable to load committed changes'
        setBranchCompareState((prev) => {
          if (options?.preserveReadyOnFailure && prev.kind === 'ready') {
            return prev
          }
          return { kind: 'error', message }
        })
        return false
      }
    },
    [client, connState, statusIdentityKey, worktreeId]
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
            const response = await client.sendRequest('git.status', {
              worktree: `id:${worktreeId}`
            })
            if (!isCurrentLoad()) {
              return false
            }
            if (response.ok) {
              const result = (response as RpcSuccess).result as MobileGitStatusResult
              setScreenState({ kind: 'ready', status: result })
              void loadBranchCompare({ preserveReadyOnFailure: true })
              if (options?.clearActionErrorOnSuccess !== false) {
                setActionError(null)
              }
              return true
            }
            if (isMobileGitUnavailable(response.error?.code, response.error?.message)) {
              setScreenState({
                kind: 'unavailable',
                message: 'Update Orca desktop to use Source Control on mobile.'
              })
              return false
            }
            const shouldRetry =
              response.error?.code === 'selector_not_found' ||
              isMobileGitTransientRefreshError(response.error?.code, response.error?.message)
            if (shouldRetry && attempt < SELECTOR_RETRY_COUNT) {
              await wait(SELECTOR_RETRY_DELAY_MS)
              if (!isCurrentLoad()) {
                return false
              }
              continue
            }
            throw new Error(response.error?.message || 'Unable to load source control')
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
    [client, connState, loadBranchCompare, statusIdentityKey, worktreeId, setActionError]
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
