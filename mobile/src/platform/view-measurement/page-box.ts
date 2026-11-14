import type { HostInstance } from 'react-native'

import type { PageBox } from './page-box-contract'

// A view's box in page coordinates, the space touch events report pageX/pageY in; null when it has none.
export function measurePageBox(target: HostInstance, onBox: (box: PageBox | null) => void): void {
  target.measure((_x, _y, width, height, left, top) => onBox({ left, top, width, height }))
}
