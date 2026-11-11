import type { View } from 'react-native'

export type PageBox = { left: number; top: number; width: number; height: number }

// A view's box in page coordinates, the space touch events report pageX/pageY in; null when it has none.
export function measurePageBox(target: View, onBox: (box: PageBox | null) => void): void {
  target.measure((_x, _y, width, height, left, top) => onBox({ left, top, width, height }))
}
