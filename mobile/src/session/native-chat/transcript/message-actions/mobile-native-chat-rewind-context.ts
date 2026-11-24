import { createContext } from 'react'
import type { AgentSessionRewindSurface } from '../../../../../../src/shared/agent-session/lifecycle/rewind/agent-session-rewind-request'

/** The chat's rewind, apart from row props so its changes redraw only the rewind buttons. */
export const MobileNativeChatRewindContext = createContext<AgentSessionRewindSurface | undefined>(
  undefined
)
