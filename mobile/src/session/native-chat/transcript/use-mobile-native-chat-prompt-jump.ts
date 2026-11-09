import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { NativeChatMessage } from '../../../../../src/shared/native-chat/native-chat-types'
import { mobileNativeChatLatestPrompt } from './mobile-native-chat-latest-prompt'
import type { MobileNativeChatTailFollow } from './use-mobile-native-chat-tail-follow'

export function useMobileNativeChatPromptJump(
  tail: MobileNativeChatTailFollow,
  rows: readonly NativeChatMessage[],
  keyOf: (row: NativeChatMessage) => string
): { mode: 'latest' | 'prompt' | null; onPress: () => void } {
  const { leaveTail, holdsIntent, list, jumpToTail, showJumpToTail } = tail
  const prompt = useMemo(() => mobileNativeChatLatestPrompt(rows), [rows])
  const key = prompt ? keyOf(prompt) : null
  const [hidden, setHidden] = useState<{ key: string; hidden: boolean } | null>(null)
  const latest = useRef({ rows, keyOf })
  const frame = useRef<number | null>(null)
  useLayoutEffect(() => {
    latest.current = { rows, keyOf }
  }, [rows, keyOf])
  useLayoutEffect(() => {
    if (key === null) {
      return
    }
    return list()?.watchRow?.(key, (shown) => setHidden({ key, hidden: !shown }))
  }, [key, prompt, showJumpToTail, list])
  useLayoutEffect(
    () => () => {
      if (frame.current !== null) {
        cancelAnimationFrame(frame.current)
      }
    },
    []
  )

  // A verdict about an earlier prompt must not show the control for a new one.
  const promptHidden = key !== null && hidden?.key === key && hidden.hidden
  const mode = showJumpToTail ? 'latest' : promptHidden ? 'prompt' : null
  const onPress = useCallback(() => {
    if (mode === 'latest') {
      jumpToTail()
      return
    }
    if (mode !== 'prompt' || !prompt) {
      return
    }
    if (frame.current !== null) {
      cancelAnimationFrame(frame.current)
      frame.current = null
    }
    const id = prompt.id
    const token = leaveTail()
    const attempt = (remaining: number) => {
      frame.current = null
      if (!holdsIntent(token)) {
        return
      }
      const row = latest.current.rows.find((row) => row.id === id)
      if (row && list()?.scrollToRow?.(latest.current.keyOf(row))) {
        return
      }
      if (row && remaining > 1) {
        frame.current = requestAnimationFrame(() => attempt(remaining - 1))
      } else {
        jumpToTail()
      }
    }
    attempt(3)
  }, [mode, prompt, leaveTail, holdsIntent, list, jumpToTail])

  return { mode, onPress }
}
