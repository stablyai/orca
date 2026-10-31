import { useKeyboardOcclusion } from '../platform/keyboard-occlusion'

// Use the platform occlusion seam: react-native-web Keyboard never fires, so pages measure visualViewport.
export function useMobileSourceControlKeyboardLift(): number {
  return useKeyboardOcclusion()
}
