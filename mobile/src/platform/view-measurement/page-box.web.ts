import type { View } from 'react-native'
import type { PageBox } from './page-box-contract'

function hasClientRect(node: unknown): node is { getBoundingClientRect: () => DOMRect } {
  return (
    typeof node === 'object' &&
    node !== null &&
    'getBoundingClientRect' in node &&
    typeof node.getBoundingClientRect === 'function'
  )
}

// Read the DOM node now: RNW's measure is async and skips its callback for a detached node, which would lose a release.
export function measurePageBox(target: View, onBox: (box: PageBox | null) => void): void {
  if (!hasClientRect(target)) {
    onBox(null)
    return
  }
  const rect = target.getBoundingClientRect()
  onBox({
    left: rect.left + window.scrollX,
    top: rect.top + window.scrollY,
    width: rect.width,
    height: rect.height
  })
}
