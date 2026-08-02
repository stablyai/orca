import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { NativeChatTextRetrieval } from '../../../src/shared/native-chat-types'

type FullTextLoader = (messageId: string, retrieval: NativeChatTextRetrieval) => Promise<string>

type CachedText = { key: string; text: string }
type ExpansionRequest = { key: string }
type RetrievalGate = { source: FullTextLoader; active: boolean }
type ExpansionState = {
  source: FullTextLoader
  cached: CachedText | null
  expandedKey: string | null
  request: ExpansionRequest | null
  errorKey: string | null
}

export type MobileNativeChatTextExpansion = {
  cached: CachedText | null
  expandedKey: string | null
  loadingKey: string | null
  errorKey: string | null
  toggle: (messageId: string, retrieval: NativeChatTextRetrieval) => void
  loadForCopy: (messageId: string, retrieval: NativeChatTextRetrieval) => Promise<string>
}

export function mobileNativeChatTextKey(
  messageId: string,
  retrieval: NativeChatTextRetrieval
): string {
  return `${messageId}\0${retrieval.capability}\0${retrieval.originalChars}`
}

/** Retains at most one full block and reuses it across collapse/re-expand. */
export function useMobileNativeChatTextExpansion(
  loadFullText: FullTextLoader,
  onExpand?: () => void
): MobileNativeChatTextExpansion {
  const [state, setState] = useState<ExpansionState>(() => emptyState(loadFullText))
  const requestRef = useRef<ExpansionRequest | null>(null)
  const retrievalGateRef = useRef<RetrievalGate>({ source: loadFullText, active: false })
  let current = state
  if (current.source !== loadFullText) {
    current = emptyState(loadFullText)
    setState(current)
  }
  if (retrievalGateRef.current.source !== loadFullText) {
    retrievalGateRef.current.source = loadFullText
  }
  useLayoutEffect(() => {
    requestRef.current = null
  }, [loadFullText])

  const readFullText = useCallback(
    async (messageId: string, retrieval: NativeChatTextRetrieval): Promise<string> => {
      const gate = retrievalGateRef.current
      if (gate.source !== loadFullText || gate.active) {
        throw new Error('Another full message is loading')
      }
      gate.active = true
      try {
        return await loadFullText(messageId, retrieval)
      } finally {
        gate.active = false
      }
    },
    [loadFullText]
  )

  const toggle = useCallback(
    (messageId: string, retrieval: NativeChatTextRetrieval): void => {
      const key = mobileNativeChatTextKey(messageId, retrieval)
      if (requestRef.current !== null) {
        return
      }
      if (current.expandedKey === key) {
        setState({ ...current, expandedKey: null })
        return
      }
      if (current.cached?.key === key) {
        onExpand?.()
        setState({ ...current, expandedKey: key, errorKey: null })
        return
      }
      onExpand?.()
      const request = { key }
      requestRef.current = request
      setState({
        source: loadFullText,
        cached: null,
        expandedKey: null,
        request,
        errorKey: null
      })
      void readFullText(messageId, retrieval)
        .then((text) => {
          setState((latest) =>
            latest.source === loadFullText && latest.request === request
              ? {
                  source: loadFullText,
                  cached: { key, text },
                  expandedKey: key,
                  request: null,
                  errorKey: null
                }
              : latest
          )
        })
        .catch(() => {
          setState((latest) =>
            latest.source === loadFullText && latest.request === request
              ? { ...latest, request: null, errorKey: key }
              : latest
          )
        })
        .finally(() => {
          if (requestRef.current === request) {
            requestRef.current = null
          }
        })
    },
    [current, loadFullText, onExpand, readFullText]
  )

  const loadForCopy = useCallback(
    (messageId: string, retrieval: NativeChatTextRetrieval): Promise<string> => {
      const key = mobileNativeChatTextKey(messageId, retrieval)
      return current.cached?.key === key
        ? Promise.resolve(current.cached.text)
        : readFullText(messageId, retrieval)
    },
    [current.cached, readFullText]
  )

  return useMemo(
    () => ({
      cached: current.cached,
      expandedKey: current.expandedKey,
      loadingKey: current.request?.key ?? null,
      errorKey: current.errorKey,
      toggle,
      loadForCopy
    }),
    [current, loadForCopy, toggle]
  )
}

function emptyState(source: FullTextLoader): ExpansionState {
  return { source, cached: null, expandedKey: null, request: null, errorKey: null }
}
