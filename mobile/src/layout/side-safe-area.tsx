import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import {
  ReleasedSideInsetContext,
  SideReleaseClaimContext,
  type ReleasedSideInset
} from './released-side-inset'
import { Platform, StyleSheet, View } from 'react-native'
import {
  SafeAreaFrameContext,
  SafeAreaInsetsContext,
  SafeAreaProvider,
  useSafeAreaFrame,
  useSafeAreaInsets,
  type EdgeInsets
} from 'react-native-safe-area-context'

const WindowSafeAreaInsetsContext = createContext<EdgeInsets | null>(null)

// Pad side cutouts/navigation bars once, then expose the padded frame and insets so descendants neither pad twice nor size past it.
export function SideSafeArea({
  children,
  releaseSide = null
}: {
  children: ReactNode
  releaseSide?: 'left' | 'right' | null
}) {
  const insets = useSafeAreaInsets()
  const frame = useSafeAreaFrame()
  const [claims, setClaims] = useState(0)
  const claim = useCallback(() => {
    setClaims((count) => count + 1)
    return () => setClaims((count) => count - 1)
  }, [])
  // A claiming screen takes the wider side, which is the status column's.
  const side = releaseSide ?? (claims > 0 ? (insets.right >= insets.left ? 'right' : 'left') : null)
  const released = useMemo<ReleasedSideInset | null>(
    () => (side !== null && insets[side] > 0 ? { side, width: insets[side] } : null),
    [side, insets]
  )
  const padLeft = released?.side === 'left' ? 0 : insets.left
  const padRight = released?.side === 'right' ? 0 : insets.right
  const areaInsets = useMemo(() => ({ ...insets, left: 0, right: 0 }), [insets])
  const areaFrame = useMemo(
    () => ({
      ...frame,
      x: frame.x + padLeft,
      width: Math.max(0, frame.width - padLeft - padRight)
    }),
    [frame, padLeft, padRight]
  )
  const area = (
    <WindowSafeAreaInsetsContext.Provider value={insets}>
      <SideReleaseClaimContext.Provider value={claim}>
        <ReleasedSideInsetContext.Provider value={released}>
          <SafeAreaFrameContext.Provider value={areaFrame}>
            <SafeAreaInsetsContext.Provider value={areaInsets}>
              {children}
            </SafeAreaInsetsContext.Provider>
          </SafeAreaFrameContext.Provider>
        </ReleasedSideInsetContext.Provider>
      </SideReleaseClaimContext.Provider>
    </WindowSafeAreaInsetsContext.Provider>
  )
  // Native SafeAreaView measures its nearest native provider, so nest one inside the padding; web reads the adjusted context.
  return (
    <View style={[styles.area, { paddingLeft: padLeft, paddingRight: padRight }]}>
      {Platform.OS === 'web' ? area : <SafeAreaProvider>{area}</SafeAreaProvider>}
    </View>
  )
}

// Modals own a separate window outside SideSafeArea and need the original window insets.
export function useWindowSafeAreaInsets(): EdgeInsets {
  const insets = useSafeAreaInsets()
  return useContext(WindowSafeAreaInsetsContext) ?? insets
}

const styles = StyleSheet.create({
  area: { flex: 1 }
})
