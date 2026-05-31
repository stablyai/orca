import { useWindowDimensions } from 'react-native'
import {
  getResponsiveLayoutMetrics,
  type ResponsiveLayoutMetrics
} from './responsive-layout-metrics'

export type ResponsiveLayout = ResponsiveLayoutMetrics

export function useResponsiveLayout(): ResponsiveLayout {
  const { width, height } = useWindowDimensions()
  return getResponsiveLayoutMetrics(width, height)
}
