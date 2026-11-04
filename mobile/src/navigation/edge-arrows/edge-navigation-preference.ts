import {
  createTerminalAccessoryLayoutPreference,
  getDefaultTerminalAccessoryBuiltInIds,
  type EdgeNavigationMode,
  type TerminalAccessoryLayout
} from '../../terminal/terminal-accessory-layout'

export type { EdgeNavigationMode }
export const EDGE_NAVIGATION_MODES = ['pills', 'strips', 'orbs', 'off'] as const
export const DEFAULT_EDGE_NAVIGATION_MODE: EdgeNavigationMode = 'pills'

export function resolveEdgeNavigationMode(
  layout: Pick<TerminalAccessoryLayout, 'edgeNavigationMode'> | null | undefined
): EdgeNavigationMode {
  const mode = layout?.edgeNavigationMode
  return mode === 'pills' || mode === 'strips' || mode === 'orbs' || mode === 'off'
    ? mode
    : DEFAULT_EDGE_NAVIGATION_MODE
}

export function isEdgeSwitcherChipHidden(
  layout: Pick<TerminalAccessoryLayout, 'edgeSwitcherChipHidden'> | null | undefined
): boolean {
  return layout?.edgeSwitcherChipHidden === true
}

export function cycleEdgeNavigationMode(current: EdgeNavigationMode): EdgeNavigationMode {
  if (current === 'pills') {
    return 'strips'
  }
  if (current === 'strips') {
    return 'orbs'
  }
  return 'pills'
}

export function setTerminalEdgeNavigationMode(
  layout: TerminalAccessoryLayout,
  edgeNavigationMode: EdgeNavigationMode,
  currentBuiltInIds = getDefaultTerminalAccessoryBuiltInIds()
): TerminalAccessoryLayout {
  const preference = createTerminalAccessoryLayoutPreference(
    { ...layout, edgeNavigationMode },
    currentBuiltInIds
  )
  return {
    directionPadEnabled: preference.directionPadEnabled,
    orderedBuiltInIds: preference.orderedBuiltInIds,
    visibleBuiltInIds: preference.visibleBuiltInIds,
    ...(preference.edgeNavigationMode !== undefined
      ? { edgeNavigationMode: preference.edgeNavigationMode }
      : {}),
    ...(preference.edgeSwitcherChipHidden === true ? { edgeSwitcherChipHidden: true } : {})
  }
}

export function setTerminalEdgeSwitcherChipHidden(
  layout: TerminalAccessoryLayout,
  hidden: boolean,
  currentBuiltInIds = getDefaultTerminalAccessoryBuiltInIds()
): TerminalAccessoryLayout {
  const preference = createTerminalAccessoryLayoutPreference(
    { ...layout, edgeSwitcherChipHidden: hidden },
    currentBuiltInIds
  )
  return {
    directionPadEnabled: preference.directionPadEnabled,
    orderedBuiltInIds: preference.orderedBuiltInIds,
    visibleBuiltInIds: preference.visibleBuiltInIds,
    ...(preference.edgeNavigationMode !== undefined
      ? { edgeNavigationMode: preference.edgeNavigationMode }
      : {}),
    ...(preference.edgeSwitcherChipHidden === true ? { edgeSwitcherChipHidden: true } : {})
  }
}
