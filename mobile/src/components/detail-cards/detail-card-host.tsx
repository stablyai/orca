import type { ReactNode, RefObject } from 'react'

export function DetailCardHostProvider({ children }: { children: ReactNode }) {
  return children
}

export function DetailCardLayer({ children }: { children: ReactNode }) {
  return children
}

export function commitDetailCardExit(settle: () => void) {
  settle()
}

export function DetailCardFocusBoundary(_props: {
  refs: RefObject<unknown[]>
  index: number
  active: boolean
}) {
  return null
}
