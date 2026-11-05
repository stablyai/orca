import {
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore
} from 'react'
import {
  playNativeChatTextReveal,
  receiveNativeChatText,
  startNativeChatTextReveal,
  type NativeChatTextRevealFrames
} from '../../../../../src/shared/native-chat/transcript/native-chat-text-reveal'
import { MobileNativeChatReplyRevealsContext } from './mobile-native-chat-reply-reveals'
import { MobileNativeChatGrowthHoldContext } from '../../mobile-native-chat-growth-hold'

const FRAMES: NativeChatTextRevealFrames = {
  now: () => performance.now(),
  request: (step) => requestAnimationFrame(step),
  cancel: (frame) => cancelAnimationFrame(frame)
}

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
  const [initial] = useState(() =>
    startNativeChatTextReveal(
      text,
      streaming,
      list?.drawn.get(rowKey),
      list?.begun.has(rowKey) === true,
      FRAMES.now()
    )
  )
  const pace = useRef(initial)
  const [shown, setShown] = useState(initial.shown)

  useLayoutEffect(() => {
    pace.current = receiveNativeChatText(pace.current, text, streaming, immediate, FRAMES.now())
    setShown(pace.current.shown)
    list?.drawn.set(rowKey, pace.current)
    list?.begun.delete(rowKey)
  }, [text, streaming, immediate, list, rowKey])

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
        setShown(next.shown)
      },
      FRAMES
    )
  }, [behind, text, list, rowKey, streaming, held])

  return immediate
    ? { text, revealing: false }
    : { text: text.slice(0, Math.min(shown, text.length)), revealing: streaming || behind }
}
