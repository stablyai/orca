import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react'
import { StyleSheet, View, useWindowDimensions } from 'react-native'
import type { DuoRailJumpFrames } from '../layout/duo-status-row'
import { useReservedRegions } from '../layout/reserved-regions'
import { getSideRailStrip } from '../layout/side-rail-strip'
import { useWindowSafeAreaInsets } from '../layout/side-safe-area'
import { useDuoChatExpanded } from './duo-chat-width'
import { duoRailJumpPlacement } from './duo-rail-jump'
import { MobileNativeChatFloatingControls } from './native-chat/MobileNativeChatFloatingControls'

type JumpActions = {
  showJumpToTail: boolean
  onJumpToTail: () => void
}

type JumpContextValue = {
  frames: DuoRailJumpFrames | null
  actions: JumpActions | null
  register: (actions: JumpActions | null) => void
  reportComposerTop: (top: number | null) => void
}

const DuoRailJumpContext = createContext<JumpContextValue | null>(null)

function sameActions(left: JumpActions | null, right: JumpActions | null): boolean {
  if (left === right) {
    return true
  }
  if (left === null || right === null) {
    return false
  }
  return left.showJumpToTail === right.showJumpToTail && left.onJumpToTail === right.onJumpToTail
}

function useRailFrames(
  chatVisible: boolean,
  keyboardInset: number,
  composerTop: number | null
): DuoRailJumpFrames | null {
  const expanded = useDuoChatExpanded()
  const { width, height } = useWindowDimensions()
  const insets = useWindowSafeAreaInsets()
  const { occlusions } = useReservedRegions()
  const strip = getSideRailStrip({
    windowWidth: width,
    windowHeight: height,
    insets,
    occlusions
  })
  return duoRailJumpPlacement({
    chatVisible,
    expanded,
    strip,
    keyboardInset,
    composerTop,
    windowWidth: width,
    windowHeight: height,
    occlusions
  })
}

export function DuoRailJumpHost({
  chatVisible,
  keyboardInset,
  children
}: {
  chatVisible: boolean
  keyboardInset: number
  children: ReactNode
}) {
  const [composerTop, setComposerTop] = useState<number | null>(null)
  const [actions, setActions] = useState<JumpActions | null>(null)
  const reportComposerTop = useCallback((top: number | null) => {
    setComposerTop((prev) => {
      if (top === null) {
        return prev === null ? prev : null
      }
      return prev !== null && Math.abs(prev - top) < 0.5 ? prev : top
    })
  }, [])
  const frames = useRailFrames(chatVisible, keyboardInset, composerTop)
  const register = useCallback((next: JumpActions | null) => {
    setActions((prev) => (sameActions(prev, next) ? prev : next))
  }, [])
  const value = useMemo(
    () => ({ frames, actions, register, reportComposerTop }),
    [frames, actions, register, reportComposerTop]
  )
  return <DuoRailJumpContext.Provider value={value}>{children}</DuoRailJumpContext.Provider>
}

/** Publishes the composer box top so rail arrows stay above it, including while the keyboard is up. */
export function DuoRailComposerTop({
  keyboardInset,
  hidden,
  children
}: {
  keyboardInset: number
  hidden?: boolean
  children: ReactNode
}) {
  const report = useContext(DuoRailJumpContext)?.reportComposerTop
  const ref = useRef<View>(null)
  const measure = useCallback(() => {
    ref.current?.measureInWindow((_x, y, _width, height) => {
      if (height > 0) {
        report?.(y)
      }
    })
  }, [report])
  useEffect(() => {
    // display:none reports height 0, which measure ignores, so a hidden composer must drop the old top.
    if (hidden) {
      report?.(null)
      return
    }
    measure()
  }, [measure, report, keyboardInset, hidden])
  return (
    <View
      ref={ref}
      collapsable={false}
      onLayout={measure}
      style={hidden ? stylesHidden : undefined}
    >
      {children}
    </View>
  )
}

const stylesHidden = { display: 'none' } as const

export function DuoRailJumpOverlay() {
  const ctx = useContext(DuoRailJumpContext)
  if (ctx?.frames == null || ctx.actions == null) {
    return null
  }
  return (
    <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
      <MobileNativeChatFloatingControls {...ctx.actions} rail={ctx.frames} />
    </View>
  )
}

/** In-transcript controls, unless the session host is drawing them in the rail. */
export function MobileNativeChatJumpControls(props: JumpActions) {
  const ctx = useContext(DuoRailJumpContext)
  useEffect(() => {
    ctx?.register(props)
    return () => ctx?.register(null)
  }, [ctx?.register, props.showJumpToTail, props.onJumpToTail])
  if (ctx?.frames != null) {
    return null
  }
  return <MobileNativeChatFloatingControls {...props} />
}
