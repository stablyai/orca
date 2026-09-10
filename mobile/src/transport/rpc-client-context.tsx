import { createContext, useContext } from 'react'
import type { RpcClientContextValue } from './rpc-client-context-contract'

export const RpcClientContext = createContext<RpcClientContextValue | null>(null)

export function useRpcClientContext(): RpcClientContextValue {
  const context = useContext(RpcClientContext)
  if (!context) {
    throw new Error('useHostClient must be used inside <RpcClientProvider>')
  }
  return context
}
