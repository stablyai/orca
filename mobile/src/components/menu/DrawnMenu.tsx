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

/** The drawn pull-down, for web and for menus whose rows show more than a native menu can. */
export function DrawnMenu({ groups, children, onOpenChange, style, testID }: NativeMenuProps) {
  const anchorRef = useRef<HostInstance>(null)
  const [open, setOpen] = useState(false)
  const [submenu, setSubmenu] = useState<MenuSubmenu | null>(null)
  const changeOpen = (next: boolean) => {
    setOpen(next)
    if (!next) {
      setSubmenu(null)
    }
    onOpenChange?.(next)
  }
  const drawn: (readonly ActionSheetAction[])[] = submenu
    ? [submenu.actions]
    : visibleMenuGroups(groups).map((group) =>
        group.map((item) =>
          isMenuSubmenu(item)
            ? {
                id: item.id,
                label: item.label,
                status: item.value,
                skipAutoClose: true,
                renderIcon: () => <ChevronRight size={16} color={colors.textMuted} />,
                onPress: () => setSubmenu(item)
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
