import { processDeviceStore } from '../../device-store/device-store'
import { useRpcClientContext } from '../../transport/connection/client-context'
import { serveDeviceStoreVerb } from './device-store-verb-server'

export function useShellDeviceStore(hostId: string, clientId: string | null) {
  const { getClientId } = useRpcClientContext()
  return (params: unknown) =>
    clientId !== null && getClientId(hostId) === clientId
      ? serveDeviceStoreVerb(processDeviceStore(), hostId, params)
      : Promise.resolve({ refusal: 'unavailable' })
}
