import type { StyleProp, ViewStyle } from 'react-native'
import type { ReactNode } from 'react'
import type { AppIcon } from '../icons/app-icon-types'
import type { ActionSheetAction } from '../sheets/ActionSheetModal'

/** An item that opens a nested list of choices, e.g. "Group by". */
export type MenuSubmenu = {
  id?: string
  label: string
  icon?: AppIcon
  /** The current choice, shown beside the label in the drawn menu. */
  value?: string
  actions: readonly ActionSheetAction[]
}

export type MenuItem = ActionSheetAction | MenuSubmenu

export type NativeMenuProps = {
  /** Groups become a menu's sections. */
  groups: readonly (readonly MenuItem[])[]
  /** The trigger; call `openMenu` from its press (a no-op where the platform opens the menu itself). */
  children: (openMenu: () => void) => ReactNode
  /** Not reported by iOS menus, which float above the app on their own. */
  onOpenChange?: (open: boolean) => void
  style?: StyleProp<ViewStyle>
  testID?: string
}

export function isMenuSubmenu(item: MenuItem): item is MenuSubmenu {
  return 'actions' in item
}

export function visibleMenuGroups(
  groups: readonly (readonly MenuItem[])[]
): (readonly MenuItem[])[] {
  return groups.map((group) => group.filter(Boolean)).filter((group) => group.length > 0)
}
