import { useCallback, useEffect, useReducer, useRef } from 'react'
import type { ConnectionState } from '../transport/types'
import type { RpcClient } from '../transport/rpc-client'
import {
  fetchMergePR,
  fetchRemovePRReviewers,
  fetchRequestPRReviewers,
  fetchRerunPRChecks,
  fetchSetPRAutoMerge,
  fetchUpdatePRState
} from './github-pr-mutations'
import type { GitHubPrRepoSlug } from './github-pr-rpc'
import { PrActionsEngine, type PrActionMutations, type PrActionBusyKey } from './pr-actions-engine'

export type { PrActionBusyKey, PrActionMutations } from './pr-actions-engine'

export type PrActionsInput = {
  client: RpcClient | null
  connState: ConnectionState
  worktreeId: string
  prNumber: number
  headSha?: string | null
  prRepo?: GitHubPrRepoSlug | null
  refetch: () => void | Promise<void>
  // Test seam: inject fake mutations; defaults to the real github.* wrappers.
  mutations?: PrActionMutations
}

function realMutations(
  client: Pick<RpcClient, 'sendRequest'>,
  worktreeId: string
): PrActionMutations {
  return {
    mergePR: (args) => fetchMergePR(client, worktreeId, args),
    setPRAutoMerge: (args) => fetchSetPRAutoMerge(client, worktreeId, args),
    updatePRState: (args) => fetchUpdatePRState(client, worktreeId, args),
    requestReviewers: (args) => fetchRequestPRReviewers(client, worktreeId, args),
    removeReviewers: (args) => fetchRemovePRReviewers(client, worktreeId, args),
    rerunChecks: (args) => fetchRerunPRChecks(client, worktreeId, args)
  }
}

// Thin React adapter over the pure PrActionsEngine. The engine owns optimistic
// + busy/error/blocked state; the hook just forces re-renders on change and
// keeps the engine's config in sync with props.
export function useMobilePrActions(input: PrActionsInput) {
  const { client, connState, worktreeId, prNumber, headSha, prRepo, refetch } = input
  const [, forceRender] = useReducer((n: number) => n + 1, 0)

  // A no-op refetch until props provide one; lets the engine exist before ready.
  const engineRef = useRef<PrActionsEngine | null>(null)
  if (engineRef.current === null) {
    engineRef.current = new PrActionsEngine({
      mutations: input.mutations ?? (client ? realMutations(client, worktreeId) : noopMutations()),
      prNumber,
      headSha,
      prRepo,
      refetch,
      onChange: forceRender
    })
  }
  const engine = engineRef.current

  // Keep engine config in sync without recreating it (preserves in-flight guards).
  useEffect(() => {
    engine.updateConfig({
      mutations: input.mutations ?? (client ? realMutations(client, worktreeId) : noopMutations()),
      prNumber,
      headSha,
      prRepo,
      refetch,
      onChange: forceRender
    })
  }, [engine, input.mutations, client, worktreeId, prNumber, headSha, prRepo, refetch])

  const ready = input.mutations !== undefined || (client !== null && connState === 'connected')

  return {
    busy: engine.busy,
    isBusy: useCallback((key: PrActionBusyKey) => engine.isBusy(key), [engine]),
    error: engine.error,
    blocked: engine.blocked,
    clearError: useCallback(() => engine.clearError(), [engine]),
    clearBlocked: useCallback(() => engine.clearBlocked(), [engine]),
    merge: useCallback(
      (method?: Parameters<PrActionsEngine['merge']>[0]) => {
        if (ready) {
          void engine.merge(method)
        }
      },
      [engine, ready]
    ),
    setAutoMerge: useCallback(
      (enabled: boolean, method?: Parameters<PrActionsEngine['setAutoMerge']>[1]) => {
        if (ready) {
          void engine.setAutoMerge(enabled, method)
        }
      },
      [engine, ready]
    ),
    updateState: useCallback(
      (state: 'open' | 'closed') => {
        if (ready) {
          void engine.updateState(state)
        }
      },
      [engine, ready]
    ),
    requestReviewer: useCallback(
      (login: string) => {
        if (ready) {
          void engine.requestReviewer(login)
        }
      },
      [engine, ready]
    ),
    removeReviewer: useCallback(
      (login: string) => {
        if (ready) {
          void engine.removeReviewer(login)
        }
      },
      [engine, ready]
    ),
    rerunFailingChecks: useCallback(() => {
      if (ready) {
        void engine.rerunFailingChecks()
      }
    }, [engine, ready]),
    resolveAutoMerge: useCallback(
      (authoritative: boolean) => engine.resolveAutoMerge(authoritative),
      [engine]
    ),
    resolveState: useCallback(
      (authoritative: Parameters<PrActionsEngine['resolveState']>[0]) =>
        engine.resolveState(authoritative),
      [engine]
    ),
    resolveReviewerRequested: useCallback(
      (login: string, authoritative: boolean) =>
        engine.resolveReviewerRequested(login, authoritative),
      [engine]
    )
  }
}

// Stand-in mutations used before a client exists; they never fire (the hook gates
// on `ready`) but keep the engine constructable.
function noopMutations(): PrActionMutations {
  const fail = async () => ({ ok: false as const, error: 'Not connected' })
  return {
    mergePR: fail,
    setPRAutoMerge: fail,
    updatePRState: fail,
    requestReviewers: fail,
    removeReviewers: fail,
    rerunChecks: fail
  }
}

export type MobilePrActions = ReturnType<typeof useMobilePrActions>
