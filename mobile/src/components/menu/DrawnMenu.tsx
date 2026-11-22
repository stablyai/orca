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

// Group-scoped, so ID-less submenus that share a label in different groups stay apart.
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
  const submenu =
    submenuKey === null
      ? undefined
      : visible
          .flatMap((group, groupIndex) =>
            group.filter(
              (item): item is MenuSubmenu =>
                isMenuSubmenu(item) && submenuKeyOf(groupIndex, item) === submenuKey
            )
          )
          .at(0)
  const changeOpen = (next: boolean) => {
    setOpen(next)
    if (!next) {
      setSubmenuKey(null)
    }
    onOpenChange?.(next)
  }
  const drawn: (readonly ActionSheetAction[])[] = submenu
    ? [submenu.actions]
    : visible.map((group, groupIndex) =>
        group.map((item) =>
          isMenuSubmenu(item)
            ? {
                id: item.id,
                label: item.label,
                status: item.value,
                skipAutoClose: true,
                renderIcon: () => <ChevronRight size={16} color={colors.textMuted} />,
                onPress: () => setSubmenuKey(submenuKeyOf(groupIndex, item))
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
