import { useCallback, useContext, useMemo, useRef, useState } from 'react'
import { Platform } from 'react-native'
import { HeaderHeightContext } from 'expo-router/react-navigation'
import { Stack, useFocusEffect, useNavigation, usePreventRemove, useRoute } from 'expo-router'
import { runAfterMenuDismiss } from '../../components/menu/run-after-menu-dismiss'
import {
  NativeStackHeader,
  type NativeHeaderItem,
  type NativeHeaderMenuEntry
} from '../../components/nav-bar/NativeStackHeader'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import {
  BRIDGE_PAGE_HEADER_BACK_ID,
  type BridgePageHeader,
  type BridgePageHeaderMenuItem
} from '../bridge/native-capabilities/bridge-page-header'
import { pageHeaderSymbol } from './page-header-symbols'

const HEADER_HIDDEN = { headerShown: false } as const
// iOS's back chevron; Material's top app bar navigates up with an arrow.
const BACK_SYMBOL = {
  ios: pageHeaderSymbol('ChevronLeft')?.ios ?? 'chevron.left',
  android: 'arrow_back'
}

/** iOS 26 draws the stack header as glass over the screen, so the page must clear it; Android lays the page below. */
export function useOverlaidHeaderHeight(): number | undefined {
  const height = useContext(HeaderHeightContext)
  return Platform.OS === 'ios' && height ? height : undefined
}

type Held = { sessionId: string | null; key: string; header: BridgePageHeader | null }

export type ShellPageHeader = {
  /** What the page asked the shell to draw, for the document now shown; null draws none. */
  header: BridgePageHeader | null
  report: (header: BridgePageHeader | null) => void
  /** Wraps a navigation the page itself asked for, so a removal it causes is not a Back to hand back to it. */
  leaving: <TArgs extends unknown[], TResult>(
    navigate: (...args: TArgs) => TResult
  ) => (...args: TArgs) => TResult
  backClaimed: boolean
  left: { readonly current: boolean }
}

export function useShellPageHeader(
  sessionId: string | null,
  backClaimed: boolean
): ShellPageHeader {
  const [held, setHeld] = useState<Held>({ sessionId: null, key: 'null', header: null })
  // Whole state per notify: an identical one changes nothing, so a page re-render costs no header update.
  const report = useCallback(
    (header: BridgePageHeader | null) => {
      const key = JSON.stringify(header)
      setHeld((previous) =>
        previous.sessionId === sessionId && previous.key === key
          ? previous
          : { sessionId, key, header }
      )
    },
    [sessionId]
  )
  const left = useRef(false)
  // Back on this screen: a push the page asked for left it in place.
  useFocusEffect(
    useCallback(() => {
      left.current = false
    }, [])
  )
  return {
    header: held.sessionId === sessionId ? held.header : null,
    report,
    leaving:
      (navigate) =>
      (...args) => {
        left.current = true
        return navigate(...args)
      },
    backClaimed,
    left
  }
}

function menuEntry(
  item: BridgePageHeaderMenuItem,
  send: (actionId: string) => void
): NativeHeaderMenuEntry {
  if ('submenu' in item) {
    return {
      key: item.label,
      label: item.label,
      symbol: pageHeaderSymbol(item.icon),
      entries: item.submenu.map((action) => menuEntry(action, send))
    }
  }
  return {
    key: item.id,
    label: item.label,
    symbol: pageHeaderSymbol(item.icon),
    destructive: item.destructive,
    disabled: item.disabled,
    isOn: item.isOn,
    // Wait for the menu to go: the press may open a native dialog, which can't present over it.
    onPress: () => runAfterMenuDismiss(() => send(item.id))
  }
}

/**
 * Draws the page's header as the native stack header while the page holds a claim. Back stays the
 * stack's own; while the page claims Back it gets the press instead, as the hardware key does.
 */
export function PageHeaderLayer({
  state,
  bridge
}: {
  state: ShellPageHeader
  bridge: { sendBack: () => boolean; sendHeaderAction: (actionId: string) => boolean }
}) {
  const t = useMobileTranslation()
  const navigation = useNavigation()
  const route = useRoute()
  const { header, left } = state
  const { sendBack, sendHeaderAction: sendAction } = bridge
  usePreventRemove(header !== null && state.backClaimed, ({ repeat }) => {
    if (left.current || !sendBack()) {
      repeat()
    }
  })
  const send = useCallback((actionId: string) => void sendAction(actionId), [sendAction])
  const items = useMemo<NativeHeaderItem[]>(
    () =>
      (header?.actions ?? []).map((action) =>
        action.kind === 'menu'
          ? {
              key: action.id,
              label: action.label,
              symbol: pageHeaderSymbol(action.icon),
              groups: action.menu.map((group) => group.map((item) => menuEntry(item, send)))
            }
          : {
              key: action.id,
              label: action.label,
              symbol: pageHeaderSymbol(action.icon),
              disabled: action.disabled,
              onPress: () => send(action.id)
            }
      ),
    [header, send]
  )
  // The stack draws Back only above its first screen; a page opened first (a host, a cold link) keeps its own.
  const ownBack = header?.back === true && navigation.getState()?.routes[0]?.key === route.key
  const backLabel = t('common.back', 'Back')
  const leftItems = useMemo<NativeHeaderItem[]>(
    () =>
      ownBack
        ? [
            {
              key: BRIDGE_PAGE_HEADER_BACK_ID,
              label: backLabel,
              symbol: BACK_SYMBOL,
              onPress: () => send(BRIDGE_PAGE_HEADER_BACK_ID)
            }
          ]
        : [],
    [backLabel, ownBack, send]
  )
  // One back only: the stack's own, or ours where the stack has none to show.
  const options = useMemo(
    () => ({ headerBackVisible: header?.back === true && !ownBack }),
    [header?.back, ownBack]
  )
  if (header === null) {
    return <Stack.Screen options={HEADER_HIDDEN} />
  }
  return (
    <NativeStackHeader
      title={header.titleVisible ? header.title : ''}
      items={items}
      leftItems={leftItems}
      options={options}
    />
  )
}
