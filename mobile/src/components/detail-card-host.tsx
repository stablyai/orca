import type { ReactNode } from 'react'

export function DetailCardHostProvider({ children }: { children: ReactNode }) {
  return children
}

export function DetailCardLayer({ children }: { children: ReactNode }) {
  return children
}

export function commitDetailCardExit(settle: () => void) {
  settle()
}
