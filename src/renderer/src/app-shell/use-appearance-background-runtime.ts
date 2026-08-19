import { useEffect, useRef } from 'react'

import { AppearanceBackgroundRuntime } from '@/lib/appearance-background-runtime'
import { useAppStore } from '@/store'

export function useAppearanceBackgroundRuntime(): void {
  const settings = useAppStore((state) => state.settings)
  const runtimeRef = useRef<AppearanceBackgroundRuntime | null>(null)

  useEffect(() => {
    const runtime = new AppearanceBackgroundRuntime(document.documentElement)
    runtimeRef.current = runtime
    return () => {
      if (runtimeRef.current === runtime) {
        runtimeRef.current = null
      }
      runtime.dispose()
    }
  }, [])

  useEffect(() => {
    runtimeRef.current?.apply(settings)
  }, [settings])
}
