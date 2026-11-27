import { createElement } from 'react'
import type { MobileIconProps } from '../../../components/icons/mobile-icon'
import { prStateIcon } from './pr-state-token'

export function PrStateIcon({ state, ...props }: { state: string } & MobileIconProps) {
  return createElement(prStateIcon(state), props)
}
