import { useCallback, useRef, useState, type MutableRefObject } from 'react'
import type { MobileSourceControlSettings } from '../transport/settings-read-operations'
import { useMobileSourceControlSettings } from './mobile-source-control-settings'
import { useFocusEffect } from 'expo-router'
import { View } from 'react-native'
import type { RpcClient } from '../transport/rpc-client'
import {
  GenerationScopedRequestOwner,
  type RequestScope
} from '../transport/generation-scoped-request-owner'
import type { ConnectionState } from '../transport/types'
import {
  nextBranchCompareState,
  readBranchCompareOutcome,
  type BranchCompareAttempt
} from './mobile-branch-compare-outcome'
import { gitStatusHostPayloadRead } from './mobile-git-read-operations'
import {
  isMobileGitTransientRefreshError,
  isMobileGitUnavailableReply,
  readMobileGitRefusal
} from './mobile-git-status'
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

type BranchCompareParameters = Readonly<Record<string, never>>
const WHOLE_WORKTREE: BranchCompareParameters = {}

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
  settings: MobileSourceControlSettings
  // Desktop's rebase target; kept apart from the compare so a failed or unsupported compare keeps it.
  rebaseBaseRef: string | null
}

export function useMobileSourceControlLoaders(params: Params): MobileSourceControlLoaders {
  const { client, connState, statusIdentityKey, worktreeId, setActionError, onStatusLoadSuccess } =
    params
  // Desktop's settings decide the compare base here and the list order and diffs upstream.
  const { settings, reload: reloadSettings } = useMobileSourceControlSettings(client, connState)
  const compareAgainstUpstream = settings.compareAgainstUpstream
  const [screenState, setScreenState] = useState<ScreenState>({ kind: 'loading' })
  const [branchCompareState, setBranchCompareState] = useState<MobileBranchCompareState>({
    kind: 'idle'
  })
  const [rebaseBaseRef, setRebaseBaseRef] = useState<string | null>(null)
  const currentStatusIdentityRef = useRef('')
  const loadGenerationRef = useRef(0)
  const mountedRef = useRef(true)
  const statusLoadInFlightRef = useRef<StatusLoadInFlight | null>(null)
  const branchCompare = useRef(
    new GenerationScopedRequestOwner<BranchCompareParameters, BranchCompareAttempt>()
  ).current
  // Reset on identity change during render so retained ready state cannot expose another host/worktree for a frame.
  const lastResetIdentityRef = useRef(statusIdentityKey)
  if (lastResetIdentityRef.current !== statusIdentityKey) {
    lastResetIdentityRef.current = statusIdentityKey
    // Retire before fresh status arrives; otherwise the old compare can publish into the new worktree.
    branchCompare.reset()
    setScreenState({ kind: 'loading' })
    setBranchCompareState({ kind: 'idle' })
    setRebaseBaseRef(null)
  }
  currentStatusIdentityRef.current = statusIdentityKey

  const setRootRef = useCallback(
    (node: View | null): void => {
      if (node !== null) {
        mountedRef.current = true
        return
      }
      // Invalidate route-detached RPC writes without waiting for passive cleanup.
      mountedRef.current = false
      loadGenerationRef.current += 1
      branchCompare.reset()
    },
    [branchCompare]
  )

  const loadBranchCompare = useCallback(
    // The compare base can be the branch's upstream, so it follows the status read that triggered it.
    async (options: { preserveReadyOnFailure: boolean; upstreamName: string | undefined }) => {
      // Each compare refresh owns a fresh reply; retire first so only the newest attempt can publish.
      branchCompare.reset()
      if (!worktreeId || !client || connState !== 'connected') {
        if (mountedRef.current) {
          setBranchCompareState({ kind: 'idle' })
        }
        return false
      }
      // Scope by host and route identity as well as render-time retirement to fence loads that reach the owner first.
      const scope: RequestScope = [client, statusIdentityKey]

      setBranchCompareState((prev) => (prev.kind === 'ready' ? prev : { kind: 'loading' }))
      const loaded = await branchCompare.load(scope, WHOLE_WORKTREE, (currency) =>
        readBranchCompareOutcome(client, worktreeId, currency, {
          compareAgainstUpstream,
          upstreamName: options.upstreamName
        })
      )
      // Mount liveness belongs to the view; a current reply still cannot publish after detach.
      if (!loaded || !mountedRef.current) {
        return false
      }
      if (branchCompare.commit(loaded.lease, loaded.value) !== 'committed') {
        return false
      }
      const outcome = loaded.value
      setRebaseBaseRef(outcome.effectiveBaseRef)
      setBranchCompareState((prev) =>
        nextBranchCompareState(outcome, prev, options.preserveReadyOnFailure)
      )
      return outcome.kind === 'ready'
    },
    [branchCompare, client, compareAgainstUpstream, connState, statusIdentityKey, worktreeId]
  )

  const loadStatus = useCallback(
    async (options?: LoadStatusOptions) => {
      if (options?.rereadSettings) {
        reloadSettings()
      }
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
            // Inspect refusal code before acceptance policy loses capability/retry routing information.
            const refusal = readMobileGitRefusal(reply)
            if (!refusal) {
              const result = gitStatusHostPayloadRead.interpret(reply)
              setScreenState({ kind: 'ready', status: result })
              void loadBranchCompare({
                preserveReadyOnFailure: true,
                upstreamName: result.upstreamStatus?.upstreamName
              })
              if (options?.clearActionErrorOnSuccess !== false) {
                setActionError(null)
              }
              // Fresh status can invalidate the failed-commit snapshot used by recovery prompts.
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
            // Mutations can succeed while refresh races an abort; retain the last good screen through transient read failure.
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
      reloadSettings,
      statusIdentityKey,
      worktreeId,
      setActionError
    ]
  )

  useFocusEffect(
    useCallback(() => {
      void loadStatus({ force: true, preserveReadyOnFailure: true })
    }, [loadStatus])
  )

  return {
    screenState,
    setScreenState,
    branchCompareState,
    setBranchCompareState,
    mountedRef,
    setRootRef,
    loadStatus,
    settings,
    rebaseBaseRef
  }
}
