import { usePageGeometry } from './reserved-regions.web'
export function useShellSideRail(): boolean {
  return usePageGeometry().sideRail
}

export function useDirectionPadAvailable(): boolean {
  return usePageGeometry().directionPadAvailable === true
}
