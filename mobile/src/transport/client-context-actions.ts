import { useRpcClientContext } from './rpc-client-react-context'

export const useCloseHost = () => useRpcClientContext().closeHost
export const useForceReconnect = () => useRpcClientContext().forceReconnect
export const useForceReconnectAfterEdit = () => useRpcClientContext().forceReconnectAfterEdit
export const usePrimeHosts = () => useRpcClientContext().primeHosts
