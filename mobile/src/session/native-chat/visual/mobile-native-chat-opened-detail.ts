import { createContext, useContext, useEffect, useId } from 'react'
import type { LayoutChangeEvent } from 'react-native'

type ReportDetail = (detailId: string, height: number | null) => void

export const MobileNativeChatOpenedDetailContext = createContext<ReportDetail | null>(null)

export function useMobileNativeChatOpenedDetail(): (event: LayoutChangeEvent) => void {
  const report = useContext(MobileNativeChatOpenedDetailContext)
  const detailId = useId()
  useEffect(() => () => report?.(detailId, null), [detailId, report])
  return (event) => report?.(detailId, event.nativeEvent.layout.height)
}
