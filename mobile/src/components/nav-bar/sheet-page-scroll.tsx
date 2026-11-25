import {
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type RefObject
} from 'react'
import { ScrollView, type ScrollViewInstance, type StyleProp, type ViewStyle } from 'react-native'

/** One scroll view whose pages swap in place: each new page header starts it at the top. Drawers reset it. */
export const SheetPageScrollContext = createContext<RefObject<ScrollViewInstance | null> | null>(
  null
)

export function useSheetPageTop(title: string): void {
  const scroll = useContext(SheetPageScrollContext)
  useLayoutEffect(() => {
    scroll?.current?.scrollTo({ y: 0, animated: false })
  }, [scroll, title])
}

/** A bar the current page pins under that scroll view, e.g. its BottomSearchBar. */
type SheetPageFooterSlot = {
  get: () => ReactNode
  set: (node: ReactNode) => void
  subscribe: (listener: () => void) => () => void
}

function createSheetPageFooterSlot(): SheetPageFooterSlot {
  let node: ReactNode = null
  const listeners = new Set<() => void>()
  return {
    get: () => node,
    set: (next) => {
      node = next
      for (const listener of listeners) {
        listener()
      }
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }
  }
}

const SheetPageFooterContext = createContext<SheetPageFooterSlot | null>(null)

// Drawn after the scroll view; only it re-renders as the page's bar changes.
function SheetPageFooter({ slot }: { slot: SheetPageFooterSlot }): ReactNode {
  return useSyncExternalStore(slot.subscribe, slot.get, slot.get)
}

/** Pins `node` under the sheet's scroll view while this page shows. */
export function useSheetPageFooter(node: ReactNode): void {
  const slot = useContext(SheetPageFooterContext)
  useLayoutEffect(() => {
    slot?.set(node)
  })
  useLayoutEffect(() => () => slot?.set(null), [slot])
}

/** A drawer's page area: the scroll view its pages swap in, and under it the bar the shown page pins. */
export function SheetPageScroll({
  style,
  children
}: {
  style: StyleProp<ViewStyle>
  children: ReactNode
}) {
  const scroll = useRef<ScrollViewInstance>(null)
  const [footer] = useState(createSheetPageFooterSlot)
  return (
    <>
      <ScrollView
        ref={scroll}
        style={style}
        showsVerticalScrollIndicator={false}
        // A search page's first tap on a result selects it, not just closes the keyboard.
        keyboardShouldPersistTaps="handled"
      >
        <SheetPageScrollContext.Provider value={scroll}>
          <SheetPageFooterContext.Provider value={footer}>
            {children}
          </SheetPageFooterContext.Provider>
        </SheetPageScrollContext.Provider>
      </ScrollView>
      <SheetPageFooter slot={footer} />
    </>
  )
}
