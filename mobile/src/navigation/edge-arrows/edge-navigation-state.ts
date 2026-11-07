import { createContext, useContext } from 'react'
import type { EdgeNavigationMode } from './edge-navigation-preference'

export type GlobalEdgeNavigationValue = {
  readonly mode: EdgeNavigationMode
  readonly switcherChipHidden: boolean
  readonly sheetVisible: boolean
  readonly setSheetVisible: (visible: boolean) => void
  readonly setMode: (mode: EdgeNavigationMode) => void
  readonly cycleMode: () => void
  readonly setSwitcherChipHidden: (hidden: boolean) => void
}

export const GlobalEdgeNavigationContext = createContext<GlobalEdgeNavigationValue | null>(null)

export function useGlobalEdgeNavigation(): GlobalEdgeNavigationValue | null {
  return useContext(GlobalEdgeNavigationContext)
}

export type AgentSessionEdgeNavContextValue = {
  readonly scopeKey: string
  readonly obscured?: boolean
  readonly canNavigateRight?: boolean
  readonly onNavigateHorizontal?: (direction: 'left' | 'right') => void
}

export const AgentSessionEdgeNavContext = createContext<AgentSessionEdgeNavContextValue | null>(
  null
)
