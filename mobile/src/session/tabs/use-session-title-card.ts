import { useCallback, useRef } from 'react'
import type { ComponentRef } from 'react'
import type { HostInstance, Text } from 'react-native'
import {
  useAnchoredDetailCard,
  type DetailCardMeasure
} from '../../components/use-anchored-detail-card'

export function useSessionTitleCard(besideTabs: boolean, obscured: boolean) {
  const barRef = useRef<HostInstance>(null)
  const titleRef = useRef<ComponentRef<typeof Text>>(null)
  // Below the session bar, lined up with the title's leading edge.
  const measure = useCallback<DetailCardMeasure>((place) => {
    const title = titleRef.current
    const bar = barRef.current
    if (!title || !bar) {
      place(null)
      return
    }
    let left: number | undefined
    let top: number | undefined
    const finish = () => {
      if (left !== undefined && top !== undefined) {
        place({ side: 'below', left, top })
      }
    }
    title.measureInWindow((x) => {
      left = x
      finish()
    })
    bar.measureInWindow((_x, y, _width, height) => {
      top = y + height
      finish()
    })
  }, [])
  const card = useAnchoredDetailCard({ geometry: String(besideTabs), obscured, measure })
  return { ...card, barRef, titleRef, besideTabs }
}

export type SessionTitleCard = ReturnType<typeof useSessionTitleCard>
