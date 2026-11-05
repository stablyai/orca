import {
  createTerminalAccessoryLayoutPreference,
  getDefaultTerminalAccessoryBuiltInIds,
  type EdgeNavigationMode,
  type TerminalAccessoryLayout
} from '../../terminal/terminal-accessory-layout'

export type { EdgeNavigationMode }
export const EDGE_NAVIGATION_MODES = ['pills', 'strips', 'orbs', 'gamepad', 'off'] as const
export const DEFAULT_EDGE_NAVIGATION_MODE: EdgeNavigationMode = 'orbs'
export const DEFAULT_EDGE_SWITCHER_CHIP_HIDDEN = true

export function resolveEdgeNavigationMode(
  layout: Pick<TerminalAccessoryLayout, 'edgeNavigationMode'> | null | undefined
): EdgeNavigationMode {
  const mode = layout?.edgeNavigationMode
  return mode === 'pills' ||
    mode === 'strips' ||
    mode === 'orbs' ||
    mode === 'gamepad' ||
    mode === 'off'
    ? mode
    : DEFAULT_EDGE_NAVIGATION_MODE
}

export function isEdgeSwitcherChipHidden(
  layout: Pick<TerminalAccessoryLayout, 'edgeSwitcherChipHidden'> | null | undefined
): boolean {
  return typeof layout?.edgeSwitcherChipHidden === 'boolean'
    ? layout.edgeSwitcherChipHidden
    : DEFAULT_EDGE_SWITCHER_CHIP_HIDDEN
}

export function cycleEdgeNavigationMode(current: EdgeNavigationMode): EdgeNavigationMode {
  if (current === 'pills') {
    return 'strips'
  }
  if (current === 'strips') {
    return 'orbs'
  }
  if (current === 'orbs') {
    return 'gamepad'
  }
  if (current === 'gamepad') {
    return 'pills'
  }
  return DEFAULT_EDGE_NAVIGATION_MODE
}

export function setTerminalEdgeNavigationMode(
  layout: TerminalAccessoryLayout,
  edgeNavigationMode: EdgeNavigationMode,
  currentBuiltInIds = getDefaultTerminalAccessoryBuiltInIds()
): TerminalAccessoryLayout {
  const { version: _version, ...nextLayout } = createTerminalAccessoryLayoutPreference(
    { ...layout, edgeNavigationMode },
    currentBuiltInIds
  )
  return nextLayout
}

export function setTerminalEdgeSwitcherChipHidden(
  layout: TerminalAccessoryLayout,
  hidden: boolean,
  currentBuiltInIds = getDefaultTerminalAccessoryBuiltInIds()
): TerminalAccessoryLayout {
  const { version: _version, ...nextLayout } = createTerminalAccessoryLayoutPreference(
    { ...layout, edgeSwitcherChipHidden: hidden },
    currentBuiltInIds
  )
  return nextLayout
}
