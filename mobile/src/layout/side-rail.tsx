import {
  createContext,
  useContext,
  useEffect,
  useId,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode
} from 'react'
import { StyleSheet, View } from 'react-native'

export type SideRailEdge = 'left' | 'right'

// Only a vertical status bar (iPhone Duo: 84pt) is this wide; landscape Dynamic Island insets stop at 62pt.
const SIDE_RAIL_MIN_INSET = 72
// Clears the clock and signal cluster at the top of the bar (it ends near 97pt unfolded and 147pt on the cover).
const SIDE_RAIL_TOP_CLEARANCE = 156

export function sideRailEdge(insets: { left: number; right: number }): SideRailEdge | null {
  if (insets.right >= SIDE_RAIL_MIN_INSET) {
    return 'right'
  }
  return insets.left >= SIDE_RAIL_MIN_INSET ? 'left' : null
}

type Claim = { id: string; node: ReactNode }

// Latest claim wins; screens claim only while focused, so a covered screen never shows through.
function createSideRailStore() {
  let claims: Claim[] = []
  const listeners = new Set<() => void>()
  const emit = () => listeners.forEach((listener) => listener())
  return {
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    top: () => claims.at(-1)?.node ?? null,
    set: (id: string, node: ReactNode) => {
      const index = claims.findIndex((claim) => claim.id === id)
      claims =
        index === -1
          ? [...claims, { id, node }]
          : claims.map((claim, i) => (i === index ? { id, node } : claim))
      emit()
    },
    release: (id: string) => {
      claims = claims.filter((claim) => claim.id !== id)
      emit()
    }
  }
}

type SideRailStore = ReturnType<typeof createSideRailStore>

const SideRailContext = createContext<{ edge: SideRailEdge | null; store: SideRailStore } | null>(
  null
)

// False for a screen a stack keeps mounted beneath the top one; its claim must not show over the screen on top.
export const SideRailOnTopContext = createContext(true)

// Which edge has a rail this screen may fill, or null when the window has none.
export function useSideRailEdge(): SideRailEdge | null {
  return useContext(SideRailContext)?.edge ?? null
}

// Show node in the rail while it is non-null and its screen is on top; pass null when there is nothing for it.
export function useSideRailClaim(node: ReactNode | null): void {
  const rail = useContext(SideRailContext)
  const onTop = useContext(SideRailOnTopContext)
  const id = useId()
  const store = rail?.edge && onTop ? rail.store : null
  const claiming = store !== null && node !== null
  // Update in place so a re-render keeps the claim's position; release only when the claim ends.
  useEffect(() => {
    if (store !== null && node !== null) {
      store.set(id, node)
    }
  }, [store, id, node])
  useEffect(() => {
    if (store === null || !claiming) {
      return
    }
    return () => store.release(id)
  }, [store, id, claiming])
}

// Owned by SideSafeArea: it already pads the rail edge, so the rail is that padding.
export function SideRailProvider({
  edge,
  width,
  bottom,
  children
}: {
  edge: SideRailEdge | null
  width: number
  bottom: number
  children: ReactNode
}) {
  const [store] = useState(createSideRailStore)
  const value = useMemo(() => ({ edge, store }), [edge, store])
  return (
    <SideRailContext.Provider value={value}>
      {children}
      {edge ? (
        <View
          style={[styles.rail, { [edge]: 0, width, paddingBottom: bottom }]}
          pointerEvents="box-none"
        >
          <SideRailSlot store={store} />
        </View>
      ) : null}
    </SideRailContext.Provider>
  )
}

function SideRailSlot({ store }: { store: SideRailStore }) {
  const node = useSyncExternalStore(store.subscribe, store.top, store.top)
  return node
}

const styles = StyleSheet.create({
  rail: {
    position: 'absolute',
    top: SIDE_RAIL_TOP_CLEARANCE,
    bottom: 0
  }
})
