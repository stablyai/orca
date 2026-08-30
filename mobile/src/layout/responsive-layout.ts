import { useRef } from 'react'
import {
  getResponsiveLayoutMetrics,
  type ResponsiveLayoutMetrics
} from './responsive-layout-metrics'
import { useWindowBounds } from './window-bounds'

export type ResponsiveLayout = ResponsiveLayoutMetrics

export function useResponsiveLayout(): ResponsiveLayout {
  const { width, height } = useWindowBounds()
  const previousRef = useRef<ResponsiveLayoutMetrics | undefined>(undefined)
  const metrics = getResponsiveLayoutMetrics(width, height, previousRef.current)
  previousRef.current = metrics
  return metrics
}
