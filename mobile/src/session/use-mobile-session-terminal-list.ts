import { useRef, useCallback, useEffect, useMemo } from 'react'
import type { RpcSuccess } from '../transport/types'
import { mergeTerminalListWithKnownRecords, terminalRecordsEqual } from './mobile-terminal-records'
import {
  createTerminalPrunePredicate,
  pruneTerminalKeyboardMetrics,
  resolveRetainedTerminalHandles
} from './mobile-terminal-prune-decision'
import type { Terminal } from './mobile-session-route-types'
import type { MobileSessionTerminalStreamDisplayModel } from './use-mobile-session-terminal-stream-display'
import { MobileTerminalInventoryRequest } from './mobile-terminal-inventory-request'
import type { MobileTerminalInventoryRefreshOptions } from './use-mobile-terminal-inventory-recovery'

export function useMobileSessionTerminalList(scope: MobileSessionTerminalStreamDisplayModel) {
  const {
    hostId,
    worktreeId,
    client,
    setTerminals,
    terminalsRef,
    sessionTabsRef,
    pruneTerminalHandlesFromLiveInput,
    defaultTerminalHandlesToLiveInput,
    clearTerminalLiveInputDefault,
    setTerminalKeyboardMetrics,
    terminalRefs,
    terminalUnsubsRef,
    initializedHandlesRef,
    viewportResubscribeBudgetRef,
    activeHandleRef,
    showNativeChatRef,
    unsubscribeTerminal,
    nativeChatStream,
    bufferedTerminalDraftState
  } = scope
  const lastKnownTerminalCountRef = useRef(0)
  const terminalInventoryRequest = useMemo(
    () => new MobileTerminalInventoryRequest(),
    [client, hostId, worktreeId]
  )

  useEffect(() => {
    lastKnownTerminalCountRef.current = 0
    return terminalInventoryRequest.activate()
  }, [terminalInventoryRequest])

  const fetchTerminals = useCallback(
    (opts: MobileTerminalInventoryRefreshOptions = {}): Promise<boolean> => {
      if (!client) {
        return Promise.resolve(false)
      }
      const allowEmptyLoaded = opts.allowEmptyLoaded ?? true
      return terminalInventoryRequest.run(
        allowEmptyLoaded,
        async (allowsEmpty, isCurrent) => {
          try {
            const response = await client.sendRequest('terminal.list', {
              worktree: `id:${worktreeId}`,
              includeVisualLayouts: false
            })
            if (!isCurrent() || !response.ok) {
              return false
            }
            const result = (response as RpcSuccess).result as { terminals: Terminal[] }
            if (result.terminals.length === 0 && !allowsEmpty()) {
              return true
            }
            // Why: require two consecutive empties before trusting 0, so transient empty responses don't flash the UI empty.
            if (result.terminals.length === 0 && lastKnownTerminalCountRef.current > 0) {
              lastKnownTerminalCountRef.current = 0
              return true
            }

            const liveHandles = new Set(result.terminals.map((terminal) => terminal.handle))
            const pruneContext = {
              liveHandles,
              showNativeChat: showNativeChatRef.current,
              activeHandle: activeHandleRef.current
            }
            // Why: terminal.list is the lifetime signal; lagging tab snapshots must not erase a user's buffered-mode opt-out.
            // Sweep against the retained set, not the raw list: a chat-covered handle
            // keeps its subscription across a graph reload, so erasing its live-input
            // preference on the same refresh is the erasure this guard exists to stop.
            const retainedHandles = resolveRetainedTerminalHandles(pruneContext)
            pruneTerminalHandlesFromLiveInput(retainedHandles)
            bufferedTerminalDraftState.pruneDrafts(retainedHandles)
            defaultTerminalHandlesToLiveInput([...liveHandles])
            const shouldPrune = createTerminalPrunePredicate(pruneContext)
            for (const handle of Array.from(terminalUnsubsRef.current.keys())) {
              if (!shouldPrune(handle)) {
                continue
              }
              unsubscribeTerminal(handle)
              terminalRefs.current.delete(handle)
              initializedHandlesRef.current.delete(handle)
              viewportResubscribeBudgetRef.current.forget(handle)
              clearTerminalLiveInputDefault(handle)
            }
            setTerminalKeyboardMetrics((prev) => pruneTerminalKeyboardMetrics(prev, shouldPrune))
            // Why: a chat-covered handle the host reports again refills its rearm budget,
            // so an exhausted rearm can't lock the composer until leave-chat.
            nativeChatStream.notifyListedHandles(liveHandles)
            // Why: same absence-gated refill for the viewport-fit budget — a handle that
            // left the list and returned may converge now, so it earns fresh attempts.
            viewportResubscribeBudgetRef.current.notifyListedHandles(liveHandles)
            lastKnownTerminalCountRef.current = result.terminals.length
            // Why: dedupe duplicate handles (rename/split race) to avoid a React duplicate-key throw; keep first for tab-strip order.
            const seen = new Set<string>()
            const deduped = result.terminals.filter((t) => {
              if (seen.has(t.handle)) {
                return false
              }
              seen.add(t.handle)
              return true
            })

            const mergedTerminals = mergeTerminalListWithKnownRecords(
              deduped,
              terminalsRef.current,
              sessionTabsRef.current
            )
            setTerminals((prev) =>
              terminalRecordsEqual(prev, mergedTerminals) ? prev : mergedTerminals
            )
            terminalsRef.current = mergedTerminals

            // Session tabs are the UI authority; terminal.list only refreshes per-handle metadata for existing terminal surfaces.
            return true
          } catch {
            // Failed to list terminals
            return false
          }
        },
        opts.onPhysicalRequestStarted
      )
    },
    [
      client,
      worktreeId,
      clearTerminalLiveInputDefault,
      defaultTerminalHandlesToLiveInput,
      nativeChatStream,
      bufferedTerminalDraftState.pruneDrafts,
      pruneTerminalHandlesFromLiveInput,
      terminalInventoryRequest,
      unsubscribeTerminal
    ]
  )
  return {
    lastKnownTerminalCountRef,
    fetchTerminals
  }
}

export type MobileSessionTerminalListModel = MobileSessionTerminalStreamDisplayModel &
  ReturnType<typeof useMobileSessionTerminalList>
