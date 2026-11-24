import { createElement } from 'react'
import type { LucideProps } from 'lucide-react-native'
import { prStateIcon } from './pr-state-token'

export function PrStateIcon({ state, ...props }: { state: string } & LucideProps) {
  return createElement(prStateIcon(state), props)
}
