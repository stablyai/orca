import type { AppIcon } from '../../components/icons/app-icon-types'
import {
  isMenuSubmenu,
  visibleMenuGroups,
  type MenuItem
} from '../../components/menu/native-menu-items'
import type { ActionSheetAction } from '../../components/sheets/ActionSheetModal'
import {
  isMenuAction,
  type ScreenHeaderAction,
  type ScreenHeaderSubtitle
} from '../../components/nav-bar/screen-header-props'
import {
  BRIDGE_PAGE_HEADER_BACK_ID,
  BRIDGE_PAGE_HEADER_TITLE_ID,
  BridgePageHeaderContentSchema,
  type BridgePageHeaderContent,
  type BridgePageHeaderMenuItem
} from '../../mobile-web-shell/bridge/native-capabilities/bridge-page-header'

/** What a page asks the shell to draw: ScreenHeader's model, plus whether the title shows yet. */
export type PageHeaderRequest = {
  title: string
  /** False while the page's own title still shows in its content. */
  titleVisible?: boolean
  onBack?: () => void
  actions?: readonly ScreenHeaderAction[]
  subtitle?: ScreenHeaderSubtitle
  onTitlePress?: () => void
}

// The shell takes hex only; a colour the page wrote another way leaves the item untinted.
function hexColor(color: string | undefined): string | undefined {
  return color !== undefined && /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(color) ? color : undefined
}

export type PageHeaderPayload = {
  header: BridgePageHeaderContent
  /** The press each id the shell may send back stands for. */
  handlers: ReadonlyMap<string, () => void>
}

// Lucide's component name; the shell maps it to the same symbols native screens draw.
function iconName(icon: AppIcon | undefined): string | undefined {
  return icon?.displayName || undefined
}

/**
 * The header as data for the shell, or null when it holds something the shell can't draw. Ids are
 * unique within this header only; the client's revision drops a press made on an earlier one.
 */
export function pageHeaderPayload(request: PageHeaderRequest): PageHeaderPayload | null {
  const handlers = new Map<string, () => void>()
  const register = (base: string, onPress: () => void): string => {
    let id = base
    for (let copy = 2; handlers.has(id); copy += 1) {
      id = `${base}#${copy}`
    }
    handlers.set(id, onPress)
    return id
  }
  if (request.onBack) {
    handlers.set(BRIDGE_PAGE_HEADER_BACK_ID, request.onBack)
  }
  if (request.onTitlePress) {
    handlers.set(BRIDGE_PAGE_HEADER_TITLE_ID, request.onTitlePress)
  }
  const subtitle = request.subtitle
  const dotColor = hexColor(subtitle?.dotColor)
  const menuAction = (prefix: string, item: ActionSheetAction) => ({
    id: register(`${prefix}/${item.id ?? item.label}`, item.onPress),
    label: item.label,
    icon: iconName(item.icon),
    ...(item.destructive ? { destructive: true } : {}),
    ...(item.disabled || item.loading ? { disabled: true } : {}),
    ...(item.checked === undefined ? {} : { isOn: item.checked })
  })
  const menuItem = (prefix: string, item: MenuItem): BridgePageHeaderMenuItem =>
    isMenuSubmenu(item)
      ? {
          label: item.label,
          icon: iconName(item.icon),
          submenu: item.actions.map((action) => menuAction(`${prefix}/${item.label}`, action))
        }
      : menuAction(prefix, item)
  const header: BridgePageHeaderContent = {
    title: request.title,
    titleVisible: request.titleVisible ?? true,
    back: request.onBack !== undefined,
    ...(subtitle ? { subtitle: { text: subtitle.text, ...(dotColor ? { dotColor } : {}) } } : {}),
    ...(request.onTitlePress ? { titlePressable: true } : {}),
    actions: (request.actions ?? []).map((action) =>
      isMenuAction(action)
        ? {
            kind: 'menu' as const,
            id: action.id,
            label: action.label,
            icon: iconName(action.icon),
            menu: visibleMenuGroups(action.menu).map((group) =>
              group.map((item) => menuItem(action.id, item))
            )
          }
        : {
            kind: 'button' as const,
            id: register(action.id, action.onPress),
            label: action.label,
            icon: iconName(action.icon),
            ...(action.disabled ? { disabled: true } : {}),
            ...(action.badge ? { badge: Math.min(action.badge, 999) } : {}),
            ...(hexColor(action.tint) ? { tint: hexColor(action.tint) } : {})
          }
    )
  }
  const parsed = BridgePageHeaderContentSchema.safeParse(header)
  return parsed.success ? { header: parsed.data, handlers } : null
}
