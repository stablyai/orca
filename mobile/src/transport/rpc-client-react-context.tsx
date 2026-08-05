import { createContext, useContext, type ReactNode } from 'react'
import type { RpcClientContextValue } from './rpc-client-context-contract'

const RpcClientReactContext = createContext<RpcClientContextValue | null>(null)

export function RpcClientContextBoundary({
  value,
  children
}: {
  value: RpcClientContextValue
  children: ReactNode
}) {
  return <RpcClientReactContext.Provider value={value}>{children}</RpcClientReactContext.Provider>
}

export function useRpcClientContext(): RpcClientContextValue {
  const context = useContext(RpcClientReactContext)
  if (!context) {
    throw new Error('useHostClient must be used inside <RpcClientProvider>')
  }
  return context
}
