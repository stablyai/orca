import { useEffect } from 'react'
import { useAppStore } from '@/store'
import { selectWindowTitle, windowTitleAppName } from '@/lib/window-title-context'

const WINDOW_TITLE_DEBOUNCE_MS = 300

export function useWindowTitle(): void {
  // Selecting the string keeps unrelated store writes from re-rendering the App root.
  const title = useAppStore(selectWindowTitle)
  const hydrated = useAppStore((s) => s.settings !== null)

  useEffect(() => {
    if (!hydrated) {
      return
    }
    // Settings off writes the plain app title immediately; only composed titles need to settle.
    const delay = title === windowTitleAppName() ? 0 : WINDOW_TITLE_DEBOUNCE_MS
    const timer = setTimeout(() => {
      if (document.title !== title) {
        document.title = title
      }
    }, delay)
    return () => clearTimeout(timer)
  }, [title, hydrated])
}
