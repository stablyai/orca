import { useCallback, useEffect, useState } from 'react'
import { loadHomeLayout, saveHomeLayout } from '../storage/preferences'
import type { HomeLayout } from './home-layout'

/** The phone's saved Home arrangement; null until the first read lands, so Home never reorders on screen. */
export function useHomeLayout(): {
  layout: HomeLayout | null
  saveLayout: (layout: HomeLayout) => void
} {
  const [layout, setLayout] = useState<HomeLayout | null>(null)
  useEffect(() => {
    let cancelled = false
    void loadHomeLayout().then((stored) => {
      if (!cancelled) {
        setLayout((current) => current ?? stored)
      }
    })
    return () => {
      cancelled = true
    }
  }, [])
  const saveLayout = useCallback((next: HomeLayout) => {
    setLayout(next)
    // A failed write leaves this session arranged; the next launch shows the last saved layout.
    void saveHomeLayout(next).catch(() => {})
  }, [])
  return { layout, saveLayout }
}
