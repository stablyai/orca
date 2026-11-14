import { useCallback, useLayoutEffect, useRef, type RefObject } from 'react'
import type { OrcaMobileWebShellViewHandle } from '../../modules/orca-mobile-web-shell/src'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import { createNativeVisualDocumentServer } from './native-visual-documents'
import { BRIDGE_VISUAL_DOCUMENT_VERB } from '../mobile-web-shell/bridge/bridge-visual-verbs'
import type { BridgeNativeVerb } from '../mobile-web-shell/bridge/bridge-native-verbs'

export function useNativeVisualDocuments(
  sessionId: string | null,
  client: RefObject<RpcClient | null>,
  view: RefObject<{ sessionId: string; handle: OrcaMobileWebShellViewHandle } | null>,
  fallback: RefObject<{
    serveNativeVerb: (verb: BridgeNativeVerb, params: unknown) => Promise<unknown>
  }>
) {
  const mounted = useRef<{
    sessionId: string | null
    server: ReturnType<typeof createNativeVisualDocumentServer>
  } | null>(null)
  useLayoutEffect(() => {
    const server = createNativeVisualDocumentServer({
      readClient: () => client.current,
      readView: () => (view.current?.sessionId === sessionId ? view.current.handle : null)
    })
    mounted.current = { sessionId, server }
    return () => {
      mounted.current = null
      server.dispose()
    }
  }, [sessionId, client, view])
  return useCallback(
    (verb: BridgeNativeVerb, params: unknown) => {
      if (verb !== BRIDGE_VISUAL_DOCUMENT_VERB) {
        return fallback.current.serveNativeVerb(verb, params)
      }
      const current = mounted.current
      return current?.sessionId === sessionId
        ? current.server.serve(params)
        : Promise.reject(new Error('The visual page is no longer mounted'))
    },
    [sessionId, fallback]
  )
}
