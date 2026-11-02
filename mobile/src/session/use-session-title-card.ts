import { useCallback, useLayoutEffect, useMemo, useRef, type ComponentRef } from 'react'
import type { Text, View } from 'react-native'
import {
  useAnchoredDetailCard,
  useDetailCardSource,
  type DetailCardSource
} from '../components/use-anchored-detail-card'

export function useSessionTitleCard(
  besideTabs: boolean,
  obscured: boolean,
  tabs: readonly { id: string }[] = [],
  titleVisible = true
) {
  const barRef = useRef<View>(null)
  const titleRef = useRef<ComponentRef<typeof Text>>(null)
  const openerRef = useRef<View>(null)
  const card = useAnchoredDetailCard(String(besideTabs), obscured)
  const source = useMemo<DetailCardSource>(
    () => ({ key: 'title', anchorRef: titleRef, barRef, openerRef, geometry: 'dismiss' }),
    []
  )
  useDetailCardSource(card, source)
  const { toggleSource } = card
  const toggle = useCallback(() => toggleSource(source), [toggleSource, source])
  const tabKey = card.visual?.source.key
  const tabId = tabKey?.startsWith('tab:') ? tabKey.slice(4) : null
  const requestedTabId = card.requestedKey?.startsWith('tab:') ? card.requestedKey.slice(4) : null
  const tabIds = useMemo(() => new Set(tabs.map((tab) => tab.id)), [tabs])
  const missingTab = Boolean(tabId && !tabIds.has(tabId))
  const missingTitle = !titleVisible && tabKey === 'title'
  const missingRequest = Boolean(
    (requestedTabId && !tabIds.has(requestedTabId)) ||
    (!titleVisible && card.requestedKey === 'title')
  )
  const missingKey = missingRequest ? card.requestedKey : missingTab || missingTitle ? tabKey : null
  const { removeSource, dismiss, refreshSource, registerSource, boundaryRefs } = card
  useLayoutEffect(() => {
    if (missingKey) {
      removeSource(missingKey)
    }
  }, [missingKey, removeSource])
  const activeKey = card.active ? card.visual?.source.key : null
  const { requestedKey } = card
  const tabDetails = useMemo(
    () => ({
      barRef,
      boundaryRefs,
      dismiss,
      refreshSource,
      registerSource,
      toggleSource,
      activeKey,
      requestedKey
    }),
    [boundaryRefs, dismiss, refreshSource, registerSource, toggleSource, activeKey, requestedKey]
  )
  return {
    tabId,
    tabDetails,
    missingTab,
    missingTitle,
    ...card,
    barRef,
    titleRef,
    openerRef,
    besideTabs,
    toggle,
    scopeOpenerRef: card.visual?.source.openerRef ?? openerRef,
    titleActive: card.active && card.visual?.source.key === 'title',
    titleRequestedOpen: card.requestedKey === 'title'
  }
}

export type SessionTitleCard = ReturnType<typeof useSessionTitleCard>
