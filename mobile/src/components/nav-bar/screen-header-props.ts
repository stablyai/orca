import type { AppIcon } from '../icons/app-icon-types'
import type { MenuItem } from '../menu/native-menu-items'

/** A header button, or a button that opens a menu. */
export type ScreenHeaderAction =
  | {
      id: string
      icon: AppIcon
      label: string
      onPress: () => void
      disabled?: boolean
      /** A count on the icon, e.g. items that need you; none at 0. */
      badge?: number
      /** Colours the icon with a state, e.g. a PR's open, merged or closed colour. */
      tint?: string
      testID?: string
    }
  | {
      id: string
      icon: AppIcon
      label: string
      /** Groups become the menu's sections. */
      menu: readonly (readonly MenuItem[])[]
      testID?: string
    }

export type ScreenHeaderProps = {
  title: string
  /** Where the drawn bar's Back goes; native headers pop the stack themselves. */
  onBack?: () => void
  /** At most two; anything more belongs in a menu. */
  actions?: readonly ScreenHeaderAction[]
  /** A top-level screen's large title, which shrinks into the bar on scroll (iOS). */
  largeTitle?: boolean
  /** One line under the title, with an optional status dot. */
  subtitle?: ScreenHeaderSubtitle
  /** Makes the title a button, e.g. one that opens the item's details. */
  onTitlePress?: () => void
}

export type ScreenHeaderSubtitle = { text: string; dotColor?: string }

export function isMenuAction(
  action: ScreenHeaderAction
): action is Extract<ScreenHeaderAction, { menu: unknown }> {
  return 'menu' in action
}

export const NO_ACTIONS: readonly ScreenHeaderAction[] = []
