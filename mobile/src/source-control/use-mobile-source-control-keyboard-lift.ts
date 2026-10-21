import { useKeyboardOcclusion } from '../platform/keyboard-occlusion'

/**
 * How far the commit bar sits above the bottom of the screen.
 *
 * The measurement moved to `platform/keyboard-occlusion`, which the review composer needs too and
 * which the page answers from `visualViewport` because react-native-web's `Keyboard` never fires.
 * This name stays because it is what the hub's state calls the number.
 */
export function useMobileSourceControlKeyboardLift(): number {
  return useKeyboardOcclusion()
}
