import { useRef } from 'react'
import { Platform } from 'react-native'
import { MenuView, type MenuAction, type MenuComponentRef } from '@expo/ui/community/menu'
import type { ActionSheetAction } from '../sheets/ActionSheetModal'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import { useMaterialSymbolImages } from '../icons/material-symbol-images'
import { sfSymbol } from '../icons/platform-symbol-names'
import { runAfterMenuDismiss } from './run-after-menu-dismiss'
import {
  isMenuSubmenu,
  visibleMenuGroups,
  type MenuItem,
  type NativeMenuProps
} from './native-menu-items'

export type { MenuItem, MenuSubmenu, NativeMenuProps } from './native-menu-items'

function itemSymbol(item: MenuItem): string | undefined {
  return Platform.OS === 'ios' ? item.icon?.nativeSymbol?.ios : item.icon?.nativeSymbol?.android
}

/** A SwiftUI menu on iOS and a Material 3 dropdown on Android, opened from the trigger it wraps. */
export function NativeMenu({ groups, children, onOpenChange, style, testID }: NativeMenuProps) {
  const scheme = useMobileColorScheme()
  const menuRef = useRef<MenuComponentRef>(null)
  const shown = visibleMenuGroups(groups)
  const androidImages = useMaterialSymbolImages(
    Platform.OS === 'android'
      ? shown
          .flat()
          .flatMap((item) => (isMenuSubmenu(item) ? [item, ...item.actions] : [item]))
          .map(itemSymbol)
          .filter((symbol): symbol is string => symbol !== undefined)
      : []
  )
  const byId = new Map<string, ActionSheetAction>()

  const image = (item: MenuItem): MenuAction['image'] => {
    const symbol = itemSymbol(item)
    if (!symbol) {
      return undefined
    }
    return Platform.OS === 'ios' ? sfSymbol(symbol) : (androidImages.get(symbol) ?? undefined)
  }
  const toNative = (item: MenuItem, id: string): MenuAction => {
    if (isMenuSubmenu(item)) {
      return {
        id,
        title: item.label,
        image: image(item),
        subactions: item.actions.map((action, index) => toNative(action, `${id}.${index}`))
      }
    }
    byId.set(id, item)
    return {
      id,
      title: item.label,
      image: image(item),
      state: item.checked === undefined ? undefined : item.checked ? 'on' : 'off',
      attributes: {
        destructive: item.destructive,
        disabled: item.disabled || item.loading
      }
    }
  }
  const actions: MenuAction[] = shown.map((group, groupIndex) => ({
    id: `${groupIndex}`,
    title: '',
    displayInline: true,
    subactions: group.map((item, index) => toNative(item, `${groupIndex}.${index}`))
  }))

  return (
    <MenuView
      ref={menuRef}
      actions={actions}
      colorScheme={scheme}
      style={style}
      testID={testID}
      onOpenMenu={() => onOpenChange?.(true)}
      onCloseMenu={() => onOpenChange?.(false)}
      onPressAction={({ nativeEvent }) => {
        const action = byId.get(nativeEvent.event)
        if (!action) {
          return
        }
        if (action.closeBeforePress) {
          runAfterMenuDismiss(action.onPress)
        } else {
          action.onPress()
        }
      }}
    >
      {/* SwiftUI opens its menu from the tap itself; Compose's opens when the trigger asks. */}
      {children(() => {
        if (Platform.OS === 'android') {
          menuRef.current?.show()
        }
      })}
    </MenuView>
  )
}
