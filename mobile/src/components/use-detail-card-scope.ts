import type { RefObject } from 'react'

export type DetailCardScopeOptions = {
  present: boolean
  obscured: boolean
  openerRef: RefObject<unknown>
  titleRef: RefObject<unknown>
  layerRef: RefObject<unknown>
  contentRef: RefObject<unknown>
  dismiss: () => void
}

export function useDetailCardScope(_options: DetailCardScopeOptions): void {}
