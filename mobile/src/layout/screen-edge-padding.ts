import { useSafeAreaInsets } from 'react-native-safe-area-context'
import {
  getHorizontalEdgePadding,
  getScreenEdgePadding,
  type HorizontalEdgePadding,
  type ScreenEdgePadding
} from './screen-edge-padding-metrics'

export function useHorizontalEdgePadding(): HorizontalEdgePadding {
  return getHorizontalEdgePadding(useSafeAreaInsets())
}

export function useScreenEdgePadding(): ScreenEdgePadding {
  return getScreenEdgePadding(useSafeAreaInsets())
}
