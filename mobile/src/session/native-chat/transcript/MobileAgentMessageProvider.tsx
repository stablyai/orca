import { useLayoutEffect, useMemo } from 'react'
import { useNow } from '../../../hooks/use-now'
import type { MobileSessionTab } from '../../mobile-session-route-types'
import {
  MobileAgentMessageContext,
  MobileAgentMessageOpenContext,
  createMobileAgentMessageSource
} from './mobile-agent-message-context'

export function MobileAgentMessageProvider({
  tabs,
  terminals,
  scopeKey,
  open,
  children
}: {
  tabs: readonly MobileSessionTab[]
  terminals: readonly { handle: string; agentIdentity?: string }[]
  scopeKey: unknown
  open?: React.ContextType<typeof MobileAgentMessageOpenContext>
  children: React.ReactNode
}) {
  const source = useMemo(() => createMobileAgentMessageSource(), [scopeKey])
  const now = useNow(60_000)
  useLayoutEffect(() => source.update(tabs, terminals, now), [source, tabs, terminals, now])
  return (
    <MobileAgentMessageOpenContext.Provider value={open}>
      <MobileAgentMessageContext.Provider value={source}>
        {children}
      </MobileAgentMessageContext.Provider>
    </MobileAgentMessageOpenContext.Provider>
  )
}
