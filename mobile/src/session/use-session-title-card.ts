import { useCallback, useRef } from 'react'
import type { ComponentRef } from 'react'
import type { Text, View } from 'react-native'
import {
  useAnchoredDetailCard,
  type DetailCardMeasure
} from '../components/use-anchored-detail-card'

export function useSessionTitleCard(besideTabs: boolean, obscured: boolean) {
  const barRef = useRef<View>(null)
  const titleRef = useRef<ComponentRef<typeof Text>>(null)
  // Below the session bar, lined up with the title's leading edge.
  const measure = useCallback<DetailCardMeasure>((root, place) => {
    const title = titleRef.current
    const bar = barRef.current
    if (!title || !bar) {
      place(null)
      return
    }
    title.measureInWindow((x) => {
      bar.measureInWindow((_x, barY, _width, barHeight) => {
        place({ side: 'below', left: x - root.x, top: barY + barHeight - root.y })
      })
    })
  }, [])
  const card = useAnchoredDetailCard({ geometry: String(besideTabs), obscured, measure })
  return { ...card, barRef, titleRef, besideTabs }
}

export type SessionTitleCard = ReturnType<typeof useSessionTitleCard>
