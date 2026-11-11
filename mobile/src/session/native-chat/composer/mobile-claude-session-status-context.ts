import { createContext } from 'react'
import type { ClaudeSessionStatus } from '../../../../../src/shared/native-chat/claude-session-status'

/** Null outside terminal-backed Claude chats, and for hosts that do not report a status. */
export const MobileClaudeSessionStatusContext = createContext<ClaudeSessionStatus | null>(null)
