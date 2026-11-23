import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import type {
  TerminalFindResults,
  TerminalWebViewHandle
} from '../../webview/terminal-webview-contract'
import type { TerminalFindDirection } from '../../webview/terminal-webview-messages'

const NO_RESULTS: TerminalFindResults = { resultIndex: -1, resultCount: 0 }

type MobileTerminalFindScope = {
  terminalRefs: RefObject<Map<string, TerminalWebViewHandle>>
  activeHandle: string | null
  // A terminal is on screen, not a chat, file, Markdown or browser tab.
  available: boolean
}

export type MobileTerminalFind = ReturnType<typeof useMobileTerminalFind>

// Find follows the focused terminal: switching panes moves the search, leaving the terminal hides it.
export function useMobileTerminalFind({
  terminalRefs,
  activeHandle,
  available
}: MobileTerminalFindScope) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  // Results belong to one terminal and query; a stale pair reads as no results until the new count lands.
  const [reported, setReported] = useState({ key: '', results: NO_RESULTS })
  const [focusKey, setFocusKey] = useState(0)
  const searchedHandleRef = useRef<string | null>(null)
  const searchKeyRef = useRef('')
  const target = open && available ? activeHandle : null
  const searchKey = target && query ? JSON.stringify([target, query]) : ''

  useEffect(() => {
    const previous = searchedHandleRef.current
    if (previous && previous !== target) {
      terminalRefs.current.get(previous)?.clearFind()
    }
    searchedHandleRef.current = target
    searchKeyRef.current = searchKey
    if (!target) {
      return
    }
    const terminal = terminalRefs.current.get(target)
    if (query) {
      terminal?.find(query, 'next', true)
    } else {
      terminal?.clearFind()
    }
  }, [target, query, searchKey, terminalRefs])

  useEffect(
    () => () => {
      const searched = searchedHandleRef.current
      if (searched) {
        terminalRefs.current.get(searched)?.clearFind()
      }
    },
    [terminalRefs]
  )

  const openFind = useCallback(() => {
    setOpen(true)
    setFocusKey((key) => key + 1)
  }, [])

  const closeFind = useCallback(() => {
    setOpen(false)
    setQuery('')
  }, [])

  const navigate = useCallback(
    (direction: TerminalFindDirection) => {
      const searched = searchedHandleRef.current
      if (searched && query) {
        terminalRefs.current.get(searched)?.find(query, direction, false)
      }
    },
    [query, terminalRefs]
  )

  // Late results from a terminal find already left must not overwrite the current count.
  const handleFindResults = useCallback((handle: string, next: TerminalFindResults) => {
    if (handle === searchedHandleRef.current) {
      setReported({ key: searchKeyRef.current, results: next })
    }
  }, [])

  return {
    available,
    open: open && available,
    query,
    // Null while the open search has not reported yet, so the bar does not claim "No results" early.
    results: !searchKey ? NO_RESULTS : reported.key === searchKey ? reported.results : null,
    focusKey,
    setQuery,
    openFind,
    closeFind,
    findNext: useCallback(() => navigate('next'), [navigate]),
    findPrevious: useCallback(() => navigate('previous'), [navigate]),
    handleFindResults
  }
}
