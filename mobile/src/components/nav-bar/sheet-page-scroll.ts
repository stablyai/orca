import { createContext, useContext, useLayoutEffect, type RefObject } from 'react'
import type { ScrollViewInstance } from 'react-native'

/** One scroll view whose pages swap in place: each new page header starts it at the top. Drawers reset it. */
export const SheetPageScrollContext = createContext<RefObject<ScrollViewInstance | null> | null>(
  null
)

export function useSheetPageTop(title: string): void {
  const scroll = useContext(SheetPageScrollContext)
  useLayoutEffect(() => {
    scroll?.current?.scrollTo({ y: 0, animated: false })
  }, [scroll, title])
}
