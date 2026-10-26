import { createContext } from 'react'
import type { MobileSessionTab } from './mobile-session-route-types'

export const MobileHeldTerminalContext = createContext<{
  tabs: readonly MobileSessionTab[]
  worktreeId: string
  agent: string
} | null>(null)
