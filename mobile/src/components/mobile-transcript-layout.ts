import { createContext, useCallback, useContext, useLayoutEffect, useState } from 'react'

type RegisterLayout = () => () => void
export const MobileTranscriptLayoutContext = createContext<RegisterLayout | null>(null)

/** Async renderers hold the initial reveal until their native size is known. */
export function useMobileTranscriptLayoutPending(pending: boolean): void {
  const register = useContext(MobileTranscriptLayoutContext)
  useLayoutEffect(() => (pending ? register?.() : undefined), [pending, register])
}

export function useMobileTranscriptLayout() {
  const [pending, setPending] = useState<ReadonlySet<symbol>>(() => new Set())
  const register = useCallback(() => {
    const token = Symbol()
    setPending((current) => new Set(current).add(token))
    return () =>
      setPending((current) => {
        const next = new Set(current)
        next.delete(token)
        return next
      })
  }, [])
  return { register, pending: pending.size > 0 }
}
