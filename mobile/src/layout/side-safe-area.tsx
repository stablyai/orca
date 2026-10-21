import { createContext, useContext, useMemo, type ReactNode } from 'react'
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

/**
 * Lays the app out clear of the window's side insets, which landscape brings: the iPhone sensor
 * housing, an Android side navigation bar or cutout. Below it the insets and frame describe the
 * padded area, so no screen pads a side twice or sizes past it.
 */
export function SideSafeArea({ children }: { children: ReactNode }) {
  const insets = useSafeAreaInsets()
  const frame = useSafeAreaFrame()
  const areaInsets = useMemo(() => ({ ...insets, left: 0, right: 0 }), [insets])
  const areaFrame = useMemo(
    () => ({
      ...frame,
      x: frame.x + insets.left,
      width: Math.max(0, frame.width - insets.left - insets.right)
    }),
    [frame, insets.left, insets.right]
  )
  const area = (
    <WindowSafeAreaInsetsContext.Provider value={insets}>
      <SafeAreaFrameContext.Provider value={areaFrame}>
        <SafeAreaInsetsContext.Provider value={areaInsets}>
          {children}
        </SafeAreaInsetsContext.Provider>
      </SafeAreaFrameContext.Provider>
    </WindowSafeAreaInsetsContext.Provider>
  )
  // A native SafeAreaView measures against the nearest native provider rather than the context, so
  // one goes inside the padding; on the web it reads the context.
  return (
    <View style={[styles.area, { paddingLeft: insets.left, paddingRight: insets.right }]}>
      {Platform.OS === 'web' ? area : <SafeAreaProvider>{area}</SafeAreaProvider>}
    </View>
  )
}

/** The window's insets, for a Modal: it opens a window of its own, outside `SideSafeArea`. */
export function useWindowSafeAreaInsets(): EdgeInsets {
  const insets = useSafeAreaInsets()
  return useContext(WindowSafeAreaInsetsContext) ?? insets
}

const styles = StyleSheet.create({
  area: { flex: 1 }
})
