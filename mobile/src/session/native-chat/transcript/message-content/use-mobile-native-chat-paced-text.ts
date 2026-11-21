import {
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore
} from 'react'
import {
  nativeChatRevealStepFrames,
  playNativeChatTextReveal,
  receiveNativeChatText,
  startNativeChatTextReveal
} from '../../../../../../src/shared/native-chat/transcript/row-content/native-chat-text-reveal'
import { MobileNativeChatReplyRevealsContext } from '../tool-results/mobile-native-chat-reply-reveals'
import { MobileNativeChatGrowthHoldContext } from '../viewport/mobile-native-chat-growth-hold'

/** Phones spread each arrival over less time than desktop, so new words show sooner. */
const REVEAL_MS = 180
const STEP_MS = 1000 / 30

export type MobileNativeChatPacedText = { text: string; revealing: boolean }

export function useMobileNativeChatPacedText(
  rowKey: string,
  text: string,
  streaming: boolean,
  paced: boolean
): MobileNativeChatPacedText {
  const chat = useContext(MobileNativeChatReplyRevealsContext)
  const growth = useContext(MobileNativeChatGrowthHoldContext)
  const held = useSyncExternalStore(growth.subscribe, growth.held, growth.held)
  const list = paced ? (chat ?? undefined) : undefined
  const immediate = list === undefined || list.reducedMotion
  const [frames] = useState(() => nativeChatRevealStepFrames(STEP_MS))
  const [initial] = useState(() =>
    startNativeChatTextReveal(
      text,
      streaming,
      list?.drawn.get(rowKey),
      list?.begun.has(rowKey) === true,
      frames.now(),
      REVEAL_MS
    )
  )
  const pace = useRef(initial)
  const [shown, setShown] = useState(initial.shown)

  useLayoutEffect(() => {
    pace.current = receiveNativeChatText(
      pace.current,
      text,
      streaming,
      immediate,
      frames.now(),
      REVEAL_MS
    )
    setShown(pace.current.shown)
    list?.drawn.set(rowKey, pace.current)
    list?.begun.delete(rowKey)
  }, [text, streaming, immediate, list, rowKey, frames])

  // A step's cost is its own render, from the step to its commit, so other work never slows it.
  const stepStartedAt = useRef<number | null>(null)
  const behind = !immediate && shown < text.length
  // Held, the reveal waits; its deadlines keep running, so it catches up in one step after.
  useEffect(() => {
    if (held) {
      return
    }
    if (!behind) {
      if (!streaming) {
        list?.drawn.delete(rowKey)
      }
      return
    }
    return playNativeChatTextReveal(
      () => pace.current,
      (next) => {
        pace.current = next
        list?.drawn.set(rowKey, next)
        stepStartedAt.current = performance.now()
        setShown(next.shown)
      },
      frames,
      REVEAL_MS
    )
  }, [behind, text, list, rowKey, streaming, held, frames])
  useLayoutEffect(() => {
    if (stepStartedAt.current !== null) {
      frames.stepCost?.(performance.now() - stepStartedAt.current)
      stepStartedAt.current = null
    }
  }, [shown, frames])

  return immediate
    ? { text, revealing: false }
    : { text: text.slice(0, Math.min(shown, text.length)), revealing: streaming || behind }
}
