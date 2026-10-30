import { createContext, useCallback, useContext } from 'react'
import { useFocusEffect } from 'expo-router'

export const HostAreaServingContext = createContext<(serving: boolean) => void>(() => {})

// Report only while focused so pushing or popping another screen returns area ownership to the host layout.
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
