import { useCallback, useEffect, useRef, type MutableRefObject } from 'react'
import type { RpcClient } from '../transport/rpc-client'
import {
  ownsMobileNativeChatWriteLease,
  requestMobileNativeChatWriteLease,
  type MobileNativeChatTerminalLease,
  type MobileNativeChatTerminalLeaseRequest
} from './mobile-native-chat-stop-lease'

export type MobileNativeChatWriteAction = {
  readonly lease: MobileNativeChatTerminalLease
  readonly terminal: string
  isCurrent: () => boolean
}

export type MobileNativeChatWriterGate = {
  runWrite: <Result>(
    write: (action: MobileNativeChatWriteAction | null) => Promise<Result>,
    staleResult: Result,
    owner?: MobileNativeChatWriteAction
  ) => Promise<Result>
}

export function useMobileNativeChatWriterGate(args: {
  client: RpcClient | null
  enabled: boolean
  handleRef: MutableRefObject<string | null>
  streamIdentity: string
}): MobileNativeChatWriterGate {
  const { client, enabled, handleRef, streamIdentity } = args
  const activeRouteRef = useRef({ client, enabled, streamIdentity })
  const routeVersionRef = useRef(0)
  const pendingRef = useRef(new Set<MobileNativeChatTerminalLeaseRequest>())

  useEffect(() => {
    activeRouteRef.current = { client, enabled, streamIdentity }
    return () => {
      routeVersionRef.current += 1
      for (const request of pendingRef.current) {
        request.cancel()
      }
      pendingRef.current.clear()
    }
  }, [client, enabled, streamIdentity])

  const runWrite = useCallback(
    async <Result>(
      write: (action: MobileNativeChatWriteAction | null) => Promise<Result>,
      staleResult: Result,
      owner?: MobileNativeChatWriteAction
    ): Promise<Result> => {
      const terminal = handleRef.current
      if (!client || !enabled || !terminal) {
        return write(null)
      }
      const routeVersion = routeVersionRef.current
      const isCurrent = (): boolean => {
        const activeRoute = activeRouteRef.current
        return (
          routeVersionRef.current === routeVersion &&
          activeRoute.client === client &&
          activeRoute.enabled &&
          activeRoute.streamIdentity === streamIdentity &&
          handleRef.current === terminal
        )
      }
      if (owner) {
        return owner.terminal === terminal &&
          owner.isCurrent() &&
          ownsMobileNativeChatWriteLease(owner.lease, terminal)
          ? write(owner)
          : staleResult
      }
      const request = requestMobileNativeChatWriteLease(terminal)
      pendingRef.current.add(request)
      let lease: MobileNativeChatTerminalLease | null = null
      try {
        lease = await request.acquired
        if (!lease || !isCurrent()) {
          return staleResult
        }
        return await write({ lease, terminal, isCurrent })
      } finally {
        pendingRef.current.delete(request)
        lease?.release()
      }
    },
    [client, enabled, handleRef, streamIdentity]
  )

  return { runWrite }
}
