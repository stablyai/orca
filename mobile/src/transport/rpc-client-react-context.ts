import { createContext, useContext } from 'react'
import type { RpcClientContextValue } from './rpc-client-context-contract'

export const RpcClientContext = createContext<RpcClientContextValue | null>(null)

export function useRpcClientContext(): RpcClientContextValue {
  const value = useContext(RpcClientContext)
  if (!value) {
    throw new Error('useRpcClientContext must be used within RpcClientProvider')
  }
  return value
}
