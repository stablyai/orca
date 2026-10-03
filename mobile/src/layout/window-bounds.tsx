import { createContext, useCallback, useContext, useState, type ReactNode } from 'react'
import {
  View,
  useWindowDimensions,
  type LayoutChangeEvent,
  type StyleProp,
  type ViewStyle
} from 'react-native'
import { resolveWindowBounds, type WindowBounds } from './window-bounds-state'

const WindowBoundsContext = createContext<WindowBounds | null>(null)

/**
 * Measures the app's root view so layout reads the window the app actually has.
 *
 * Why: in Android freeform windows and Samsung DeX, `useWindowDimensions()` can keep reporting the
 * display rather than the resizable Activity, so width-driven layout and terminal fits go stale.
 */
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
      <View style={style} onLayout={handleLayout}>
        {children}
      </View>
    </WindowBoundsContext.Provider>
  )
}

/** The measured root bounds, or React Native's window dimensions outside the provider. */
export function useWindowBounds(): WindowBounds {
  const measured = useContext(WindowBoundsContext)
  const fallback = useWindowDimensions()
  return resolveWindowBounds({ measured, fallback })
}
