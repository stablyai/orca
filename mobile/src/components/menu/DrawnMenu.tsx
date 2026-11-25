import { useRef, useState } from 'react'
import { View, type HostInstance } from 'react-native'
import { ChevronRight } from '../icons/app-icons'
import { PullDownMenu } from '../nav-bar/PullDownMenu'
import type { ActionSheetAction } from '../sheets/ActionSheetModal'
import { colors } from '../../theme/mobile-theme'
import {
  isMenuSubmenu,
  visibleMenuGroups,
  type MenuSubmenu,
  type NativeMenuProps
} from './native-menu-items'

// Scoped by the caller's group position (before empty groups drop out), so ID-less submenus that
// share a label stay apart even when an earlier group empties while one is open.
function submenuKeyOf(groupIndex: number, item: MenuSubmenu): string {
  return `${groupIndex}/${item.id ?? item.label}`
}

/** The drawn pull-down, for web and for menus whose rows show more than a native menu can. */
export function DrawnMenu({ groups, children, onOpenChange, style, testID }: NativeMenuProps) {
  const anchorRef = useRef<HostInstance>(null)
  const [open, setOpen] = useState(false)
  // The key, not the object: its actions must come from the current groups, which can change while open.
  const [submenuKey, setSubmenuKey] = useState<string | null>(null)
  const visible = visibleMenuGroups(groups)
  const submenus = new Map<MenuSubmenu, string>()
  groups.forEach((group, groupIndex) => {
    for (const item of group.filter(Boolean)) {
      if (isMenuSubmenu(item)) {
        submenus.set(item, submenuKeyOf(groupIndex, item))
      }
    }
  })
  const submenu =
    submenuKey === null ? undefined : [...submenus].find(([, key]) => key === submenuKey)?.[0]
  const changeOpen = (next: boolean) => {
    setOpen(next)
    if (!next) {
      setSubmenuKey(null)
    }
    onOpenChange?.(next)
  }
  const drawn: (readonly ActionSheetAction[])[] = submenu
    ? [submenu.actions]
    : visible.map((group) =>
        group.map((item) =>
          isMenuSubmenu(item)
            ? {
                id: item.id,
                label: item.label,
                status: item.value,
                skipAutoClose: true,
                renderIcon: () => <ChevronRight size={16} color={colors.textMuted} />,
                onPress: () => setSubmenuKey(submenus.get(item) ?? null)
              }
            : item
        )
      )
  return (
    <>
      <View ref={anchorRef} collapsable={false} style={style} testID={testID}>
        {children(() => changeOpen(true))}
      </View>
      <PullDownMenu
        visible={open}
        anchorRef={anchorRef}
        groups={drawn}
        onClose={() => changeOpen(false)}
      />
    </>
  )
}
