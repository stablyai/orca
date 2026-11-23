import { useRpcClientContext } from '../../transport/connection/client-context'
import { BRIDGE_STORE_VERB } from '../bridge/native-capabilities/bridge-store-verb'
import type { BridgeNativeVerb } from '../bridge/native-capabilities/bridge-native-verbs'
import { createDocumentNativeAuthority } from './document-native-authority'
import { useShellNativeVerbServer } from './use-shell-native-verb-server'

export function useShellNativeVerb(
  clientId: string | null,
  server: Parameters<typeof useShellNativeVerbServer>[0]
) {
  const { getClientId } = useRpcClientContext()
  const serveShellVerb = useShellNativeVerbServer(server)
  const { isCurrent: hasNativeAuthority, fenceStorageWrite } = createDocumentNativeAuthority(
    server.hostId,
    clientId,
    getClientId
  )
  const serveNativeVerb = (verb: BridgeNativeVerb, params: unknown): Promise<unknown> => {
    if (!hasNativeAuthority()) {
      return verb === BRIDGE_STORE_VERB
        ? Promise.resolve({ refusal: 'unavailable' })
        : Promise.reject(new Error('the document has no current native authority'))
    }
    return serveShellVerb(verb, params)
  }
  return { fenceStorageWrite, serveNativeVerb }
}
