import { createContext, useCallback, useContext, useMemo, useSyncExternalStore } from 'react'
import {
  receiptSettledBodySource,
  type AgentSessionSettledBodyOwner
} from '../../../src/shared/agent-session-settled-body-reader'
import type { NativeChatResolvedPrompt } from '../../../src/shared/native-chat-resolution-receipt'
export const MobileNativeChatSettledBodyContext =
  createContext<AgentSessionSettledBodyOwner | null>(null)
const unavailable = { status: 'error' } as const
export function useMobileNativeChatSettledBody(body: NativeChatResolvedPrompt) {
  const owner = useContext(MobileNativeChatSettledBodyContext)
  const source = useMemo(() => receiptSettledBodySource(owner, body), [owner, body])
  return useSyncExternalStore(
    useCallback(
      (listener) => (source && owner ? owner.reader.subscribe(source, listener) : () => {}),
      [owner, source]
    ),
    useCallback(
      () => (source && owner ? owner.reader.getSnapshot(source) : unavailable),
      [owner, source]
    )
  )
}
