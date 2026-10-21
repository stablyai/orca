import type { RefObject } from 'react'
import type { ScrollView } from 'react-native'

/**
 * RN Web renders a ScrollView as a div and drives its overflow from a class, so clearing the
 * inline value restores scrolling and no saved copy of it is needed. `overflowY` rather than
 * `touch-action`, which stops a touch drag but leaves the wheel and the trackpad scrolling.
 */
export function setTerminalSettingsScrollEnabled(
  ref: RefObject<ScrollView | null>,
  enabled: boolean
): void {
  const node = ref.current
  if (node instanceof HTMLElement) {
    node.style.overflowY = enabled ? '' : 'hidden'
  }
}
