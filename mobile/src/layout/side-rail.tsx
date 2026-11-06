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
import {
  getSideRailStrip,
  hasTerminalDirectionPadSpace,
  sideRailStripAboveKeyboard,
  type SideRailStrip
} from './side-rail-strip'

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

const SideRailContext = createContext<{
  strip: SideRailStrip | null
  directionPadAvailable: boolean
  store: RailStore
} | null>(null)

/**
 * Lets one screen draw controls in a side inset strip the screens are laid out clear of, such as
 * the iPhone Duo's status column. Sits outside `SideSafeArea`, which pads every screen out of it.
 */
export function SideRailProvider({ children }: { children: ReactNode }) {
  const [store] = useState(createRailStore)
  const { width, height } = useWindowDimensions()
  const insets = useSafeAreaInsets()
  const { occlusions, hasFoldDivision } = useReservedRegions()
  // Landscape, the keyboard covers the strip's bottom; the rail then holds fewer keys, not hidden ones.
  const keyboard = Math.max(0, useKeyboardOcclusion())
  const unoccludedStrip = useMemo(
    () => getSideRailStrip({ windowWidth: width, windowHeight: height, insets, occlusions }),
    [width, height, insets, occlusions]
  )
  const strip = useMemo(
    () => sideRailStripAboveKeyboard(unoccludedStrip, keyboard),
    [unoccludedStrip, keyboard]
  )
  // Keyboard clipping changes what fits now, not this device's shortcut defaults.
  const directionPadAvailable =
    hasFoldDivision === true || hasTerminalDirectionPadSpace(unoccludedStrip)
  const value = useMemo(
    () => ({ strip, directionPadAvailable, store }),
    [strip, directionPadAvailable, store]
  )
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

export function useSideRailDirectionPadAvailable(): boolean {
  return useContext(SideRailContext)?.directionPadAvailable ?? false
}

/** Draws `node` in the side strip while this screen is mounted; null draws nothing. */
export function useSideRailContent(node: ReactNode | null): void {
  // The store outlives strip changes, which replace the context value; re-registering on them would flash the rail.
  const store = useContext(SideRailContext)?.store
  const [owner] = useState(() => Symbol('side-rail-owner'))
  useEffect(() => {
    if (!store || node === null) {
      return
    }
    store.show(owner, node)
    return () => store.hide(owner)
  }, [store, owner, node])
}

const styles = StyleSheet.create({
  outlet: { position: 'absolute' }
})
