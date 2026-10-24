import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { TerminalWebViewHandle } from './terminal-webview-contract'
import { isInitReady } from './use-terminal-webview-controller'

// Why: a lost init 'ready' must not keep a painted terminal hidden. Past this the gate fails open,
// which is never worse than having no gate.
export const SURFACE_REVEAL_FALLBACK_MS = 5000

type TerminalWebViewDocumentLifecycleOptions = {
  handle: TerminalWebViewHandle
  receive: (msg: Record<string, unknown>) => void
  resetReadiness: () => void
  pingsOnForegroundRecovery: () => boolean
}

/**
 * Whether the native WebView may be shown yet, across every way its document is replaced.
 *
 * Why: the engine's inline script blocks the document's first paint, and iOS can resume with a
 * blanked backing store. Until a frame commits, the opaque WKWebView shows its native white
 * surface, not the theme around it (#17304). So the view stays at opacity 0 behind the themed
 * container until init's 'ready', and every path that discards the painted document — load start,
 * reload, content-process loss, foreground recovery — hides it again.
 */
export function useTerminalWebViewDocumentLifecycle({
  handle,
  receive,
  resetReadiness,
  pingsOnForegroundRecovery
}: TerminalWebViewDocumentLifecycleOptions) {
  const [surfaceReady, setSurfaceReady] = useState(false)
  const fallbackRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearRevealFallback = useCallback(() => {
    if (fallbackRef.current) {
      clearTimeout(fallbackRef.current)
      fallbackRef.current = null
    }
  }, [])
  useEffect(() => clearRevealFallback, [clearRevealFallback])

  const revealSurface = useCallback(() => {
    clearRevealFallback()
    setSurfaceReady(true)
  }, [clearRevealFallback])
  const hideSurface = useCallback(() => {
    clearRevealFallback()
    setSurfaceReady(false)
  }, [clearRevealFallback])

  const invalidateDocument = useCallback(() => {
    hideSurface()
    resetReadiness()
  }, [hideSurface, resetReadiness])

  const receiveGated = useCallback(
    (msg: Record<string, unknown>) => {
      if (isInitReady(msg)) {
        revealSurface()
      }
      receive(msg)
    },
    [receive, revealSurface]
  )

  const gatedHandle = useMemo<TerminalWebViewHandle>(
    () => ({
      ...handle,
      prepareForForegroundRecovery() {
        // Why: only a recovery that pings may come back blanked; the re-init's ready reveals it.
        if (pingsOnForegroundRecovery()) {
          hideSurface()
        }
        handle.prepareForForegroundRecovery()
      },
      init(init) {
        // Why: armed here because a pane the session never subscribed never inits, and has
        // nothing to reveal.
        clearRevealFallback()
        fallbackRef.current = setTimeout(revealSurface, SURFACE_REVEAL_FALLBACK_MS)
        handle.init(init)
      }
    }),
    [clearRevealFallback, handle, hideSurface, pingsOnForegroundRecovery, revealSurface]
  )

  return { gatedHandle, hideSurface, invalidateDocument, receive: receiveGated, surfaceReady }
}
