import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode
} from 'react'
import { StyleSheet, useWindowDimensions, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useReservedRegions } from './reserved-regions'
import { useKeyboardOcclusion } from '../platform/keyboard-occlusion'
import { getSideRailStrip, sideRailStripAboveKeyboard, type SideRailStrip } from './side-rail-strip'

/** One screen's claim on the strip; each screen holds its own. */
type SideRailOwner = symbol

type RailContent = { owner: SideRailOwner; node: ReactNode }

function createRailStore() {
  let content: RailContent | null = null
  const listeners = new Set<() => void>()
  const notify = () => {
    for (const listener of listeners) {
      listener()
    }
  }
  return {
    read: () => content,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    show: (owner: SideRailOwner, node: ReactNode) => {
      content = { owner, node }
      notify()
    },
    // Only the screen that showed it takes it down, so a screen leaving never hides its successor's.
    hide: (owner: SideRailOwner) => {
      if (content?.owner === owner) {
        content = null
        notify()
      }
    }
  }
}

type RailStore = ReturnType<typeof createRailStore>

const SideRailContext = createContext<{ strip: SideRailStrip | null; store: RailStore } | null>(
  null
)

/**
 * Lets one screen draw controls in a side inset strip the screens are laid out clear of, such as
 * the iPhone Duo's status column. Sits outside `SideSafeArea`, which pads every screen out of it.
 */
export function SideRailProvider({ children }: { children: ReactNode }) {
  const [store] = useState(createRailStore)
  const { width, height } = useWindowDimensions()
  const insets = useSafeAreaInsets()
  const { occlusions } = useReservedRegions()
  // Landscape, the keyboard covers the strip's bottom; the rail then holds fewer keys, not hidden ones.
  const keyboard = Math.max(0, useKeyboardOcclusion())
  const strip = useMemo(
    () =>
      sideRailStripAboveKeyboard(
        getSideRailStrip({ windowWidth: width, windowHeight: height, insets, occlusions }),
        keyboard
      ),
    [width, height, insets, occlusions, keyboard]
  )
  const value = useMemo(() => ({ strip, store }), [strip, store])
  return (
    <SideRailContext.Provider value={value}>
      {children}
      <SideRailOutlet />
    </SideRailContext.Provider>
  )
}

function SideRailOutlet() {
  const context = useContext(SideRailContext)
  const content = useSyncExternalStore(
    context?.store.subscribe ?? (() => () => undefined),
    () => context?.store.read() ?? null
  )
  const strip = context?.strip
  if (!strip || !content) {
    return null
  }
  return (
    <View
      style={[
        styles.outlet,
        { width: strip.width, top: strip.top, bottom: strip.bottom },
        strip.side === 'right' ? { right: 0 } : { left: 0 }
      ]}
    >
      {content.node}
    </View>
  )
}

/** The side strip this window has to draw in; null for a window without one. */
export function useSideRailStrip(): SideRailStrip | null {
  return useContext(SideRailContext)?.strip ?? null
}

/** Draws `node` in the side strip while this screen is mounted; null draws nothing. */
export function useSideRailContent(node: ReactNode | null): void {
  const context = useContext(SideRailContext)
  const [owner] = useState(() => Symbol('side-rail-owner'))
  useEffect(() => {
    if (!context || node === null) {
      return
    }
    context.store.show(owner, node)
    return () => context.store.hide(owner)
  }, [context, owner, node])
}

const styles = StyleSheet.create({
  outlet: { position: 'absolute' }
})
