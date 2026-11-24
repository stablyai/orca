import type { RefObject } from 'react'

export type DetailCardScopeOptions = {
  active: boolean
  obscured: boolean
  openerRef: RefObject<unknown>
  backRef: RefObject<unknown>
  boundaryRefs: RefObject<unknown[]>
  contentRef: RefObject<unknown>
  dismiss: () => void
}

export function useDetailCardScope(_options: DetailCardScopeOptions): void {}
