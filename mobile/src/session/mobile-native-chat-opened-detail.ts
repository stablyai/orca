import { createContext, useContext, useEffect, useId } from 'react'
import type { LayoutChangeEvent } from 'react-native'

type ReportDetail = (detailId: string, height: number | null) => void

/** An opened run's box grows by the height of every detail opened in it, as desktop's does. */
export const MobileNativeChatOpenedDetailContext = createContext<ReportDetail | null>(null)

/** The `onLayout` for an opened detail, which reports its height to the run's box. */
export function useMobileNativeChatOpenedDetail(): (event: LayoutChangeEvent) => void {
  const report = useContext(MobileNativeChatOpenedDetailContext)
  const detailId = useId()
  useEffect(() => () => report?.(detailId, null), [detailId, report])
  return (event) => report?.(detailId, event.nativeEvent.layout.height)
}
