import { useRef, useCallback, useEffect, useMemo } from 'react'
import { sessionTerminalListRead } from './mobile-session-read-operations'
import type { Terminal } from './mobile-session-route-types'
import { mergeTerminalListWithKnownRecords, terminalRecordsEqual } from './mobile-terminal-records'
import {
  createTerminalPrunePredicate,
  pruneTerminalHandleMap,
  resolveRetainedTerminalHandles
} from './mobile-terminal-prune-decision'
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
    setTerminalModes,
    ptyModesRef,
    terminalCwdRef,
    subscribeSeqRef,
    initialModesSeenRef,
    webReadyHandlesRef,
    terminalRefs,
    terminalUnsubsRef,
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
            const response = sessionTerminalListRead.interpret(
              await sessionTerminalListRead.request(client, {
                worktree: `id:${worktreeId}`,
                includeVisualLayouts: false
              })
            )
            if (!isCurrent() || !response.accepted) {
              return false
            }
            // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the reader checked the array and each row's handle; the rest of a row is the host's terminal record, which this module reads but does not re-declare.
            const result = response.value as { terminals: Terminal[] }
            if (result.terminals.length === 0 && !allowsEmpty()) {
              return true
            }
            // Require consecutive empty inventories so transient omissions cannot flash the screen empty.
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
            // Sweep preferences against retained subscriptions, not transient list omissions, so chat leases keep their live-input opt-out.
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
              viewportResubscribeBudgetRef.current.forget(handle)
              clearTerminalLiveInputDefault(handle)
            }
            for (const cache of [
              ptyModesRef.current,
              terminalCwdRef.current,
              initialModesSeenRef.current,
              webReadyHandlesRef.current
            ]) {
              for (const handle of cache.keys()) {
                if (shouldPrune(handle)) {
                  cache.delete(handle)
                }
              }
            }
            for (const handle of subscribeSeqRef.current.keys()) {
              if (shouldPrune(handle)) {
                viewportResubscribeBudgetRef.current.forget(handle)
                subscribeSeqRef.current.delete(handle)
              }
            }
            setTerminalModes((prev) => pruneTerminalHandleMap(prev, shouldPrune))
            setTerminalKeyboardMetrics((prev) => pruneTerminalHandleMap(prev, shouldPrune))
            // Reappearing handles may have live PTYs and earn a fresh chat rearm budget.
            nativeChatStream.notifyListedHandles(liveHandles)
            // Refill viewport attempts only after real handle absence and return.
            viewportResubscribeBudgetRef.current.notifyListedHandles(liveHandles)
            lastKnownTerminalCountRef.current = result.terminals.length
            // Dedupe handles from rename/split races before React sees duplicate keys; preserve first-seen strip order.
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

            // Session tabs own surfaces; inventory refreshes only existing terminals’ metadata.
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
