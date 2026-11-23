import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import type { NativeChatMessage } from '../../../../../../src/shared/native-chat/native-chat-types'
import { createMobileNativeChatLandedPrompt } from './mobile-native-chat-landed-prompt'
import { mobileNativeChatPromptAbove } from './mobile-native-chat-prompt-above'
import {
  mobileNativeChatRowOffsets,
  type MobileNativeChatScrollNode
} from './mobile-native-chat-reading-place'

type PromptStepRows = {
  rows: readonly NativeChatMessage[]
  keys: readonly string[]
  indexOf: ReadonlyMap<string, number>
  first: number
  rowKeys: { scope: string }
}

export function useMobileNativeChatPromptStep({
  latest,
  scope,
  scroller,
  onAvailable,
  onEndDistance,
  keepDrawn,
  scrollRowToTop
}: {
  latest: RefObject<PromptStepRows>
  scope: string
  scroller: () => MobileNativeChatScrollNode | null
  onAvailable: (available: boolean) => void
  onEndDistance: (fromEnd: number, byReader: boolean) => void
  keepDrawn: (index: number) => void
  scrollRowToTop: (key: string) => boolean
}) {
  const [landed] = useState(createMobileNativeChatLandedPrompt)
  const jump = useRef<{ scope: string; key: string } | null>(null)

  useLayoutEffect(() => () => onAvailable(false), [onAvailable])
  useLayoutEffect(() => () => landed.show(undefined), [landed, scope])

  const cancel = useCallback(() => {
    jump.current = null
  }, [])
  const target = useCallback(
    (s: MobileNativeChatScrollNode) => {
      const { rows, keys, first } = latest.current
      return s.clientHeight > 0
        ? mobileNativeChatPromptAbove(rows, keys, first, mobileNativeChatRowOffsets(s))
        : undefined
    },
    [latest]
  )
  const update = useCallback(
    (s: MobileNativeChatScrollNode) => onAvailable(!!target(s)),
    [onAvailable, target]
  )
  const land = useCallback(
    (s: MobileNativeChatScrollNode, key: string) => {
      const didLand = scrollRowToTop(key)
      cancel()
      if (didLand) {
        landed.show(key)
        onEndDistance(Math.max(0, -s.scrollTop), false)
      }
      update(s)
    },
    [cancel, landed, onEndDistance, scrollRowToTop, update]
  )
  const previous = useCallback(
    (beforeJump: () => void) => {
      const s = scroller()
      const prompt = s && target(s)
      if (!s || !prompt) {
        return
      }
      beforeJump()
      const { first, rowKeys } = latest.current
      if (prompt.index < first) {
        jump.current = { scope: rowKeys.scope, key: prompt.key }
        keepDrawn(prompt.index)
      } else {
        land(s, prompt.key)
      }
    },
    [keepDrawn, land, latest, scroller, target]
  )
  const afterCommit = useCallback(
    (s: MobileNativeChatScrollNode) => {
      const pending = jump.current
      const { rowKeys, indexOf, first } = latest.current
      if (pending) {
        const index = pending.scope === rowKeys.scope ? indexOf.get(pending.key) : undefined
        if (index === undefined) {
          cancel()
        } else if (index >= first) {
          land(s, pending.key)
          return
        }
      }
      update(s)
    },
    [cancel, land, latest, update]
  )

  return { afterCommit, cancel, landed, previous, update }
}
