import { useCallback, useEffect, useReducer, useRef } from 'react'
import { useMobileTranslation } from '../../../../i18n/use-mobile-translation'
import type { ConnectionState } from '../../../../transport/connection/connection-state'
import type { RpcClient } from '../../../../transport/rpc/rpc-client-contract'
import {
  fetchMergePR,
  fetchRemovePRReviewers,
  fetchRequestPRReviewers,
  fetchRerunPRChecks,
  fetchSetPRAutoMerge,
  fetchUpdatePRState
} from '../../github-operations/github-pr-mutations'
import {
  fetchMarkPRDraft,
  fetchMarkPRReadyForReview
} from '../../github-operations/github-pr-draft-mutations'
import type { GitHubPrRepoSlug } from '../../github-operations/github-pr-repo-slug'
import type { UnvalidatedRpcRequestPort } from '../../../../transport/rpc/unvalidated-rpc-request-port'
import { PrActionsEngine, type PrActionBusyKey } from './pr-actions-engine'
import './pr-action-mutation-contract'
import type { PrActionMutations } from './pr-action-mutation-contract'

export type PrActionsInput = {
  client: RpcClient | null
  connState: ConnectionState
  worktreeId: string
  prNumber: number
  headSha?: string | null
  prRepo?: GitHubPrRepoSlug | null
  refetch: (action: PrActionBusyKey) => void | Promise<void>
  mutations?: PrActionMutations
}

function realMutations(client: UnvalidatedRpcRequestPort, worktreeId: string): PrActionMutations {
  return {
    mergePR: (args) => fetchMergePR(client, worktreeId, args),
    setPRAutoMerge: (args) => fetchSetPRAutoMerge(client, worktreeId, args),
    updatePRState: (args) => fetchUpdatePRState(client, worktreeId, args),
    markReadyForReview: (args) => fetchMarkPRReadyForReview(client, worktreeId, args),
    markDraft: (args) => fetchMarkPRDraft(client, worktreeId, args),
    requestReviewers: (args) => fetchRequestPRReviewers(client, worktreeId, args),
    removeReviewers: (args) => fetchRemovePRReviewers(client, worktreeId, args),
    rerunChecks: (args) => fetchRerunPRChecks(client, worktreeId, args)
  }
}

export function useMobilePrActions(input: PrActionsInput) {
  useMobileTranslation()
  const { client, connState, worktreeId, prNumber, headSha, prRepo, refetch } = input
  const [, forceRender] = useReducer((n: number) => n + 1, 0)

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
      (method?: Parameters<PrActionsEngine['merge']>[0]): Promise<boolean> =>
        ready ? engine.merge(method) : Promise.resolve(false),
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
    markReadyForReview: useCallback(() => {
      if (ready) {
        void engine.setDraft(false)
      }
    }, [engine, ready]),
    markDraft: useCallback(() => {
      if (ready) {
        void engine.setDraft(true)
      }
    }, [engine, ready]),
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

// Keep inert mutations until a client exists; the ready gate prevents sending them.
function noopMutations(): PrActionMutations {
  const fail = async () => ({ ok: false as const, error: 'Not connected' })
  return {
    mergePR: fail,
    setPRAutoMerge: fail,
    updatePRState: fail,
    markReadyForReview: fail,
    markDraft: fail,
    requestReviewers: fail,
    removeReviewers: fail,
    rerunChecks: fail
  }
}

export type MobilePrActions = ReturnType<typeof useMobilePrActions>
