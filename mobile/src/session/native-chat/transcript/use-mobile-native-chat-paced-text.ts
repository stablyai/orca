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
} from '../../../../../src/shared/native-chat/transcript/row-content/native-chat-text-reveal'
import { MobileNativeChatReplyRevealsContext } from './mobile-native-chat-reply-reveals'
import { MobileNativeChatGrowthHoldContext } from './mobile-native-chat-growth-hold'

/** Phones spread each arrival over less time than desktop, so new words show sooner. */
const REVEAL_MS = 180
/** Each reveal step parses and draws the reply again, so phones step at most 30 times a second. */
const REVEAL_STEP_MS = 1000 / 30
/** Half a 60 Hz frame, so a step lands on every second frame there and every fourth at 120 Hz. */
const FRAME_SLACK_MS = 8
/** The animation frame each pending step is waiting on. */
const waitingSteps = new Map<number, number>()

const FRAMES: NativeChatTextRevealFrames = {
  now: () => performance.now(),
  request: (step) => {
    const due = performance.now() + REVEAL_STEP_MS - FRAME_SLACK_MS
    const wait = (frameStart: number): void => {
      if (frameStart < due) {
        waitingSteps.set(id, requestAnimationFrame(wait))
        return
      }
      waitingSteps.delete(id)
      step()
    }
    const id = requestAnimationFrame(wait)
    waitingSteps.set(id, id)
    return id
  },
  cancel: (id) => {
    const frame = waitingSteps.get(id)
    if (frame !== undefined) {
      cancelAnimationFrame(frame)
      waitingSteps.delete(id)
    }
  }
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
      FRAMES.now(),
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
      FRAMES.now(),
      REVEAL_MS
    )
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
      FRAMES,
      REVEAL_MS
    )
  }, [behind, text, list, rowKey, streaming, held])

  return immediate
    ? { text, revealing: false }
    : { text: text.slice(0, Math.min(shown, text.length)), revealing: streaming || behind }
}
