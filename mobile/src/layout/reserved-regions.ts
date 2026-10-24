import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import {
  Platform,
  View,
  useWindowDimensions,
  type ViewProps,
  type ViewInstance
} from 'react-native'
import {
  ReservedRegionsProvider,
  useReservedRegions as useMeasuredRegions
} from 'react-native-reserved-regions'
import { partitionReservedRegions, type ReservedRegions } from './reserved-regions-contract'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

const NO_REGIONS: ReservedRegions = { divisions: [], occlusions: [] }
const Provider = Platform.OS === 'ios' ? ReservedRegionsProvider : View
const WindowOriginContext = createContext<Readonly<{ x: number; y: number }> | null>(null)

/** Keeps provider-local regions in the window coordinates used by safe areas and the WebView. */
export function WindowReservedRegionsProvider({ onLayout, ...props }: ViewProps) {
  const ref = useRef<ViewInstance>(null)
  const [origin, setOrigin] = useState<Readonly<{ x: number; y: number }> | null>(null)
  const { width, height } = useWindowDimensions()
  const insets = useSafeAreaInsets()
  const measure = useCallback(() => {
    ref.current?.measureInWindow((x, y) => {
      if (Number.isFinite(x) && Number.isFinite(y)) {
        setOrigin((held) => (held?.x === x && held.y === y ? held : { x, y }))
      }
    })
  }, [])
  useEffect(measure, [measure, width, height, insets.left, insets.right, insets.top, insets.bottom])
  const handleLayout = useCallback<NonNullable<ViewProps['onLayout']>>(
    (event) => {
      measure()
      onLayout?.(event)
    },
    [measure, onLayout]
  )
  return createElement(
    WindowOriginContext.Provider,
    { value: origin },
    createElement(Provider, { ...props, ref, onLayout: handleLayout })
  )
}

function useIOSReservedRegions(): ReservedRegions {
  const regions = useMeasuredRegions()
  const origin = useContext(WindowOriginContext)
  return useMemo(
    () => (origin === null ? NO_REGIONS : partitionReservedRegions(regions, origin)),
    [regions, origin]
  )
}

// Platform is fixed for a native binary; Android keeps its existing layout policy.
export const useReservedRegions =
  Platform.OS === 'ios' ? useIOSReservedRegions : (): ReservedRegions => NO_REGIONS
