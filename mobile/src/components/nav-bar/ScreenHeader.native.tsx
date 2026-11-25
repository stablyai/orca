import { isMenuSubmenu, visibleMenuGroups, type MenuItem } from '../menu/native-menu-items'
import { runAfterMenuDismiss } from '../menu/run-after-menu-dismiss'
import { NativeStackHeader, type NativeHeaderMenuEntry } from './NativeStackHeader'
import { isMenuAction, NO_ACTIONS, type ScreenHeaderProps } from './screen-header-props'

export type { ScreenHeaderAction, ScreenHeaderProps } from './screen-header-props'

/** Phones get the native stack header, so screens leave the top safe area to it. */
export const NATIVE_SCREEN_HEADER = true

function menuEntry(item: MenuItem, key: string): NativeHeaderMenuEntry {
  return isMenuSubmenu(item)
    ? {
        key,
        label: item.label,
        symbol: item.icon?.nativeSymbol,
        entries: item.actions.map((action, index) => menuEntry(action, `${key}.${index}`))
      }
    : {
        key,
        label: item.label,
        symbol: item.icon?.nativeSymbol,
        destructive: item.destructive,
        disabled: item.disabled || item.loading,
        isOn: item.checked,
        onPress: () => (item.closeBeforePress ? runAfterMenuDismiss(item.onPress) : item.onPress())
      }
}

/** The native stack header: UINavigationBar (Liquid Glass on iOS 26) or the Material top app bar. */
export function ScreenHeader({
  title,
  actions = NO_ACTIONS,
  largeTitle = false,
  subtitle,
  onTitlePress
}: ScreenHeaderProps) {
  return (
    <NativeStackHeader
      title={title}
      largeTitle={largeTitle}
      subtitle={subtitle}
      onTitlePress={onTitlePress}
      items={actions.map((action) =>
        isMenuAction(action)
          ? {
              key: action.id,
              label: action.label,
              symbol: action.icon.nativeSymbol,
              groups: visibleMenuGroups(action.menu).map((group, groupIndex) =>
                group.map((item, index) => menuEntry(item, `${groupIndex}.${index}`))
              )
            }
          : {
              key: action.id,
              label: action.label,
              symbol: action.icon.nativeSymbol,
              disabled: action.disabled,
              badge: action.badge,
              tint: action.tint,
              onPress: action.onPress
            }
      )}
    />
  )
}
