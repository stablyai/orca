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
}

export function isMenuAction(
  action: ScreenHeaderAction
): action is Extract<ScreenHeaderAction, { menu: unknown }> {
  return 'menu' in action
}

export const NO_ACTIONS: readonly ScreenHeaderAction[] = []
