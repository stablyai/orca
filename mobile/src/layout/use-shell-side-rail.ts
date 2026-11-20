import { useSideRailStrip, useSideRailDirectionPadAvailable } from './side-rail'
export function useShellSideRail(): boolean {
  return useSideRailStrip() !== null
}

export function useDirectionPadAvailable(): boolean {
  return useSideRailDirectionPadAvailable()
}
