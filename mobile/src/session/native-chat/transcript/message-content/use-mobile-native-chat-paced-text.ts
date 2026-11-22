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
  savePacedNativeChatText,
  startNativeChatTextReveal
} from '../../../../../../src/shared/native-chat/transcript/row-content/native-chat-text-reveal'
import { MobileNativeChatReplyRevealsContext } from '../tool-results/mobile-native-chat-reply-reveals'
import { MobileNativeChatGrowthHoldContext } from '../viewport/mobile-native-chat-growth-hold'

/** Phones spread each arrival over less time than desktop, so new words show sooner. */
const REVEAL_MS = 180
const STEP_MS = 1000 / 30
/** A slow-drawing reply leaves most of the JS thread to scrolling and input. */
const REVEAL_BUSY_SHARE = 1 / 10

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
  const [frames] = useState(() => nativeChatRevealStepFrames(STEP_MS, REVEAL_BUSY_SHARE))
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
  // A reply redrawn whole each step shows as saves would until it ends.
  const [savePaced, setSavePaced] = useState(initial.savePaced === true)

  useLayoutEffect(() => {
    pace.current = receiveNativeChatText(
      pace.current,
      text,
      streaming,
      immediate,
      frames.now(),
      REVEAL_MS
    )
    // While text is still to reveal, only the frame clock steps it, so arrivals don't add renders.
    if (immediate || pace.current.savePaced || pace.current.shown >= text.length) {
      setShown(pace.current.shown)
    }
    list?.drawn.set(rowKey, pace.current)
    list?.begun.delete(rowKey)
  }, [text, streaming, immediate, list, rowKey, frames])

  // A step's cost runs from the step to its commit.
  const stepStartedAt = useRef<number | null>(null)
  // The length on screen; arrivals can move the reveal ahead of it without rendering.
  const onScreen = useRef(initial.shown)
  const behind = !immediate && !savePaced && shown < text.length
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
        // A step that shows nothing new renders nothing, so there is no cost to time.
        stepStartedAt.current = next.shown === onScreen.current ? null : performance.now()
        pace.current = next
        list?.drawn.set(rowKey, next)
        setShown(next.shown)
      },
      frames,
      REVEAL_MS
    )
  }, [behind, text, list, rowKey, streaming, held, frames])
  useLayoutEffect(() => {
    onScreen.current = shown
    if (stepStartedAt.current !== null) {
      frames.stepCost?.(performance.now() - stepStartedAt.current)
      stepStartedAt.current = null
      if (frames.redrawsWhole?.() && !pace.current.savePaced) {
        pace.current = savePacedNativeChatText(pace.current)
        list?.drawn.set(rowKey, pace.current)
        setSavePaced(true)
        setShown(pace.current.shown)
      }
    }
  }, [shown, frames, list, rowKey])

  return immediate
    ? { text, revealing: false }
    : {
        text: text.slice(0, Math.min(shown, text.length)),
        revealing: !savePaced && (streaming || behind)
      }
}
