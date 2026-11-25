import { useEffect, useLayoutEffect, useRef } from 'react'
import type { HostInstance } from 'react-native'
import { usePageBridgeClientIfPresent } from '../transport/connection/client-context.web'
import type { PageBackEdgeGuard } from '../mobile-web-shell/bridge/page-lifecycle/page-back-edge-guards'
import type { BackEdgeGuardHandle } from './use-back-edge-guard'

// Tells the shell where this view sits, so a swipe from the screen's edge there stays with the page
// instead of going Back. Shells from before the field ignore it; outside a shell there's nothing to tell.
export function useBackEdgeGuard(enabled: boolean): BackEdgeGuardHandle {
  const client = usePageBridgeClientIfPresent()
  const ref = useRef<HostInstance | null>(null)
  const guardRef = useRef<PageBackEdgeGuard | null>(null)
  const measure = () => {
    ref.current?.measureInWindow((_x, y, _width, height) => {
      guardRef.current?.place(height > 0 ? { top: y, bottom: y + height } : null)
    })
  }
  useEffect(() => {
    if (!client || !enabled) {
      return
    }
    const guard = client.guardBackEdge(measure)
    guardRef.current = guard
    measure()
    return () => {
      guard.release()
      guardRef.current = null
    }
  }, [client, enabled])
  // A move without a resize (the header taking new insets) fires no layout event, so measure after each commit;
  // an unchanged band sends nothing.
  useLayoutEffect(() => {
    if (guardRef.current) {
      measure()
    }
  })
  return { ref, onLayout: measure }
}
