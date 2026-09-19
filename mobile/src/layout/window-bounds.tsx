import { createContext, useCallback, useContext, useState, type ReactNode } from 'react'
import {
  StyleSheet,
  View,
  useWindowDimensions,
  type LayoutChangeEvent,
  type StyleProp,
  type ViewStyle
} from 'react-native'
import { resolveWindowBounds, type WindowBounds } from './window-bounds-state'

const WindowBoundsContext = createContext<WindowBounds | null>(null)

export function WindowBoundsProvider({
  children,
  onLayout,
  style
}: {
  children: ReactNode
  onLayout?: (event: LayoutChangeEvent) => void
  style?: StyleProp<ViewStyle>
}) {
  const [measured, setMeasured] = useState<WindowBounds | null>(null)
  const handleLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const { width, height } = event.nativeEvent.layout
      setMeasured((current) =>
        current?.width === width && current.height === height ? current : { width, height }
      )
      onLayout?.(event)
    },
    [onLayout]
  )

  return (
    <WindowBoundsContext.Provider value={measured}>
      <View style={[styles.root, style]} onLayout={handleLayout}>
        {children}
      </View>
    </WindowBoundsContext.Provider>
  )
}

export function useWindowBounds(): WindowBounds {
  const measured = useContext(WindowBoundsContext)
  const fallback = useWindowDimensions()
  return resolveWindowBounds({ measured, fallback })
}

const styles = StyleSheet.create({ root: { flex: 1 } })
