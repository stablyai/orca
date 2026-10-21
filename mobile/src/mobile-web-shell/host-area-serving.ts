import { createContext, useCallback, useContext } from 'react'
import { useFocusEffect } from 'expo-router'

/** The host layout's setter: true while the focused host route's page owns the area. */
export const HostAreaServingContext = createContext<(serving: boolean) => void>(() => {})

/** Focus-scoped, so a screen pushed over this one, or popped off it, hands the report back. */
export function useReportedHostAreaServing(serving: boolean): void {
  const report = useContext(HostAreaServingContext)
  useFocusEffect(
    useCallback(() => {
      if (!serving) {
        return
      }
      report(true)
      return () => report(false)
    }, [report, serving])
  )
}
