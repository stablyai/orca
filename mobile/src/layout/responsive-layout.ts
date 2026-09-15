import {
  getResponsiveLayoutMetrics,
  type ResponsiveLayoutMetrics
} from './responsive-layout-metrics'
import { useWindowBounds } from './window-bounds'

export type ResponsiveLayout = ResponsiveLayoutMetrics

export function useResponsiveLayout(): ResponsiveLayout {
  const { width, height } = useWindowBounds()
  return getResponsiveLayoutMetrics(width, height)
}
