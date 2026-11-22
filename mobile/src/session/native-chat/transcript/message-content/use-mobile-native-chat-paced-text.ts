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
import {
  savePacedNativeChatText,
  savePacedNativeChatTextDue
} from '../../../../../../src/shared/native-chat/transcript/row-content/native-chat-text-reveal-save-paced'
import { REVEAL_STEP_TIMED_EXACTLY, renderRevealStep } from './render-reveal-step'
import { MobileNativeChatReplyRevealsContext } from '../tool-results/mobile-native-chat-reply-reveals'
import { MobileNativeChatGrowthHoldContext } from '../viewport/mobile-native-chat-growth-hold'

/** Phones spread each arrival over less time than desktop, so new words show sooner. */
const REVEAL_MS = 180
/** Reduced motion still steps on the clock, so slow replies back off, but each step shows all it has. */
const REDUCED_MOTION_REVEAL_MS = 1
/** Text arrives every 60 ms; stepping faster would parse and draw the reply again between arrivals. */
const STEP_MS = 60
/** A slow-drawing reply leaves most of the JS thread to scrolling and input. */
const REVEAL_BUSY_SHARE = 1 / 10

export type MobileNativeChatPacedText = { text: string; revealing: boolean }

export function useMobileNativeChatPacedText(
  rowKey: string,
  text: string,
  streaming: boolean,
  paced: boolean,
  /** The row's saved journal revision, so a reply showing as saves would shows each save. */
  savedRevision?: number
): MobileNativeChatPacedText {
  const chat = useContext(MobileNativeChatReplyRevealsContext)
  const growth = useContext(MobileNativeChatGrowthHoldContext)
  const held = useSyncExternalStore(growth.subscribe, growth.held, growth.held)
  const list = paced ? (chat ?? undefined) : undefined
  const immediate = list === undefined
  const reducedMotion = list?.reducedMotion === true
  const revealMs = reducedMotion ? REDUCED_MOTION_REVEAL_MS : REVEAL_MS
  const [frames] = useState(() => nativeChatRevealStepFrames(STEP_MS, REVEAL_BUSY_SHARE))
  const [initial] = useState(() => {
    const started = startNativeChatTextReveal(
      text,
      streaming,
      list?.drawn.get(rowKey),
      list?.begun.has(rowKey) === true,
      frames.now(),
      revealMs,
      savedRevision
    )
    // Native can't time a step apart from the work queued before it, so it shows as saves would.
    return REVEAL_STEP_TIMED_EXACTLY || immediate
      ? started
      : savePacedNativeChatText(started, frames.now(), savedRevision)
  })
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
      revealMs,
      savedRevision
    )
    // While text is still to reveal, only the frame clock steps it, so arrivals don't add renders.
    if (immediate || pace.current.savePaced || pace.current.shown >= text.length) {
      setShown(pace.current.shown)
    }
    list?.drawn.set(rowKey, pace.current)
    list?.begun.delete(rowKey)
  }, [text, streaming, immediate, list, rowKey, frames, revealMs, savedRevision])

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
        renderRevealStep(() => setShown(next.shown))
      },
      frames,
      revealMs
    )
  }, [behind, text, list, rowKey, streaming, held, frames, revealMs])
  useLayoutEffect(() => {
    onScreen.current = shown
    if (stepStartedAt.current !== null) {
      frames.stepCost?.(performance.now() - stepStartedAt.current)
      stepStartedAt.current = null
      if (frames.redrawsWhole?.() && !pace.current.savePaced) {
        pace.current = savePacedNativeChatText(pace.current, performance.now(), savedRevision)
        list?.drawn.set(rowKey, pace.current)
        setSavePaced(true)
        setShown(pace.current.shown)
      }
    }
  }, [shown, frames, list, rowKey, savedRevision])

  // Held-back text still shows once the reply has waited its longest step, even if no more arrives.
  useEffect(() => {
    const due = savePaced && streaming ? savePacedNativeChatTextDue(pace.current, text) : undefined
    if (due === undefined) {
      return
    }
    const timer = setTimeout(
      () => {
        pace.current = receiveNativeChatText(
          pace.current,
          text,
          true,
          false,
          // A timer can fire a little early; at its deadline the held text is due.
          Math.max(frames.now(), due),
          revealMs,
          savedRevision
        )
        list?.drawn.set(rowKey, pace.current)
        setShown(pace.current.shown)
      },
      Math.max(0, Math.ceil(due - frames.now()))
    )
    return () => clearTimeout(timer)
  }, [savePaced, streaming, text, list, rowKey, frames, revealMs, savedRevision])

  return immediate
    ? { text, revealing: false }
    : {
        text: text.slice(0, Math.min(shown, text.length)),
        revealing: !reducedMotion && !savePaced && (streaming || behind)
      }
}
