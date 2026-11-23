import { useRpcClientContext } from '../../transport/connection/client-context'
import { BRIDGE_STORE_VERB } from '../bridge/native-capabilities/bridge-store-verb'
import type { BridgeNativeVerb } from '../bridge/native-capabilities/bridge-native-verbs'
import { useShellNativeVerbServer } from './use-shell-native-verb-server'

export function useShellNativeVerb(
  clientId: string | null,
  server: Parameters<typeof useShellNativeVerbServer>[0]
) {
  const { getClientId } = useRpcClientContext()
  const serveShellVerb = useShellNativeVerbServer(server)
  return (verb: BridgeNativeVerb, params: unknown): Promise<unknown> => {
    if (clientId === null || getClientId(server.hostId) !== clientId) {
      return verb === BRIDGE_STORE_VERB
        ? Promise.resolve({ refusal: 'unavailable' })
        : Promise.reject(new Error('the document has no current native authority'))
    }
    return serveShellVerb(verb, params)
  }
}
