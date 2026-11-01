import { createContext } from 'react'
import type { RpcClient } from '../transport/rpc-client'

/** The session's connected host client, for composers that sit too deep to be handed it; null hides usage. */
export const ComposerUsageClientContext = createContext<RpcClient | null>(null)

/** The active tab's agent as the host identifies it; used when the chat or dock has not resolved one. */
export const ComposerUsageTabAgentContext = createContext<string | null>(null)
