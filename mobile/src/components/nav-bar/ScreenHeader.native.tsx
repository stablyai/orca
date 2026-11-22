import { Platform } from 'react-native'
import { Stack } from 'expo-router'
import type { SFSymbol } from 'expo-symbols'
import type { AppIcon } from '../icons/app-icon-types'
import { useMaterialSymbolImages } from '../icons/material-symbol-images'
import { isMenuSubmenu, visibleMenuGroups, type MenuItem } from '../menu/native-menu-items'
import { runAfterMenuDismiss } from '../menu/run-after-menu-dismiss'
import { isMenuAction, NO_ACTIONS, type ScreenHeaderProps } from './screen-header-props'

export type { ScreenHeaderAction, ScreenHeaderProps } from './screen-header-props'

/** Phones get the native stack header, so screens leave the top safe area to it. */
export const NATIVE_SCREEN_HEADER = true

function symbolOf(icon: AppIcon | undefined): string | undefined {
  return Platform.OS === 'ios' ? icon?.nativeSymbol?.ios : icon?.nativeSymbol?.android
}

/** The native stack header: UINavigationBar (Liquid Glass on iOS 26) or the Material top app bar. */
export function ScreenHeader({
  title,
  actions = NO_ACTIONS,
  largeTitle = false
}: ScreenHeaderProps) {
  const menuItems = actions.flatMap((action) =>
    isMenuAction(action)
      ? visibleMenuGroups(action.menu)
          .flat()
          .flatMap((item) => (isMenuSubmenu(item) ? [item, ...item.actions] : [item]))
      : []
  )
  const androidImages = useMaterialSymbolImages(
    Platform.OS === 'android'
      ? [...actions, ...menuItems]
          .map((item) => symbolOf(item.icon))
          .filter((symbol): symbol is string => symbol !== undefined)
      : []
  )
  const iconOf = (icon: AppIcon | undefined) => {
    const symbol = symbolOf(icon)
    if (!symbol) {
      return undefined
    }
    return Platform.OS === 'ios' ? (symbol as SFSymbol) : (androidImages.get(symbol) ?? undefined)
  }

  const renderItem = (item: MenuItem, key: string) =>
    isMenuSubmenu(item) ? (
      <Stack.Toolbar.Menu key={key} title={item.label} icon={iconOf(item.icon)}>
        {item.actions.map((action, index) => renderItem(action, `${key}.${index}`))}
      </Stack.Toolbar.Menu>
    ) : (
      <Stack.Toolbar.MenuAction
        key={key}
        icon={iconOf(item.icon)}
        destructive={item.destructive}
        disabled={item.disabled || item.loading}
        isOn={item.checked}
        onPress={() => (item.closeBeforePress ? runAfterMenuDismiss(item.onPress) : item.onPress())}
      >
        {item.label}
      </Stack.Toolbar.MenuAction>
    )

  return (
    <>
      <Stack.Screen options={{ headerShown: true, title, headerLargeTitle: largeTitle }} />
      {actions.length > 0 ? (
        <Stack.Toolbar placement="right">
          {actions.map((action) =>
            isMenuAction(action) ? (
              <Stack.Toolbar.Menu
                key={action.id}
                icon={iconOf(action.icon)}
                accessibilityLabel={action.label}
              >
                {visibleMenuGroups(action.menu).map((group, groupIndex) => (
                  <Stack.Toolbar.Menu key={groupIndex} inline>
                    {group.map((item, index) => renderItem(item, `${groupIndex}.${index}`))}
                  </Stack.Toolbar.Menu>
                ))}
              </Stack.Toolbar.Menu>
            ) : (
              <Stack.Toolbar.Button
                key={action.id}
                icon={iconOf(action.icon)}
                accessibilityLabel={action.label}
                disabled={action.disabled}
                onPress={action.onPress}
              />
            )
          )}
        </Stack.Toolbar>
      ) : null}
    </>
  )
}
