import { useEffect, useEffectEvent, useRef } from 'react'
import type { NativeChatMessage } from '../../../../../../src/shared/native-chat/native-chat-types'
import type { MobileSessionItemNavigation } from '../../../mobile-session-item-target'
import type { OlderPagePhase } from '../ingestion/use-mobile-older-page-loader'
import type { MobileNativeChatRowKeys } from '../projection/mobile-native-chat-row-keys'
import type { MobileNativeChatTailFollow } from './use-mobile-native-chat-tail-follow'

export type MobileNativeChatItemJump = {
  rowKey: string
  beforeScroll: () => void
  complete: () => void
}

// A link searches a bounded history window; only a real row scroll changes follow intent.
export function useMobileNativeChatItemNavigation(args: {
  navigation?: MobileSessionItemNavigation | null
  rows: readonly NativeChatMessage[]
  rowKeys: MobileNativeChatRowKeys
  ready: boolean
  hasMore?: boolean
  olderPages: OlderPagePhase
  loadEarlier: () => void
  tail: MobileNativeChatTailFollow
}): MobileNativeChatItemJump | undefined {
  const { navigation, rows, rowKeys, ready, hasMore, olderPages, loadEarlier, tail } = args
  const target = navigation?.target
  const attempt = useRef<{ target: typeof target; pages: number; head?: string } | null>(null)
  const missing = useEffectEvent(() => {
    navigation?.complete('missing')
  })
  useEffect(() => {
    if (!target) {
      return
    }
    attempt.current = { target, pages: 0 }
    const timer = setTimeout(() => missing(), 15_000)
    return () => {
      clearTimeout(timer)
      navigation?.complete('aborted')
    }
  }, [target])
  const row = target ? rows.find((row) => row.id === target.itemId) : undefined
  useEffect(() => {
    if (!navigation || !ready) {
      return
    }
    if (navigation.pendingPrompt) {
      navigation.complete('landed')
      return
    }
    if (row || olderPages === 'loading') {
      return
    }
    const search = attempt.current
    const head = rows[0]?.id ?? ''
    if (!hasMore || olderPages !== 'idle' || !search || search.pages >= 8 || search.head === head) {
      missing()
      return
    }
    search.head = head
    search.pages += 1
    loadEarlier()
  }, [navigation, ready, row, rows, hasMore, olderPages, loadEarlier])
  return navigation && ready && !navigation.pendingPrompt && row
    ? {
        rowKey: rowKeys.keyOf(row),
        beforeScroll: tail.beginUserScroll,
        complete: () => navigation.complete('landed')
      }
    : undefined
}
