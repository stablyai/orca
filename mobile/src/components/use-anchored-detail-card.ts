import { useCallback, useLayoutEffect, useReducer, useRef, useState } from 'react'
import { useWindowDimensions, type LayoutChangeEvent, type View } from 'react-native'
import type { DetailCardAnchor, DetailCardPlacement } from './AnchoredDetailCard'
import { useBackClaim } from '../navigation/use-back-claim'
import { useWindowSafeAreaInsets } from '../layout/side-safe-area'

type State = {
  serial: number
  request: number | null
  visual: { anchor: DetailCardAnchor; target: 0 | 1; motion: number } | null
}
type Action =
  | { type: 'toggle'; eligible: boolean }
  | { type: 'close'; request?: number }
  | { type: 'measured'; request: number; anchor: DetailCardAnchor }
  | { type: 'moved'; anchor: DetailCardAnchor }
  | { type: 'settled'; motion: number }

function reduce(state: State, action: Action): State {
  const { visual, request, serial } = state
  switch (action.type) {
    case 'toggle':
      if (request === null && visual?.target !== 1) {
        return action.eligible ? { ...state, serial: serial + 1, request: serial + 1 } : state
      }
      return reduce(state, { type: 'close' })
    case 'close':
      if (action.request !== undefined && action.request !== request) {
        return state
      }
      return visual?.target === 1
        ? {
            ...state,
            request: null,
            serial: serial + 1,
            visual: { ...visual, target: 0, motion: serial + 1 }
          }
        : { ...state, request: null }
    case 'measured': {
      if (action.request !== request) {
        return state
      }
      const { anchor } = action
      return {
        serial: serial + 1,
        request: null,
        visual: { anchor, target: 1, motion: serial + 1 }
      }
    }
    case 'moved':
      return visual?.target === 1
        ? { ...state, visual: { ...visual, anchor: action.anchor } }
        : state
    case 'settled':
      return visual?.target === 0 && visual.motion === action.motion
        ? { ...state, visual: null }
        : state
  }
}

/** Places the card from window coordinates; null when its views are gone or hidden, which closes it. */
export type DetailCardMeasure = (
  root: { x: number; y: number },
  place: (placement: DetailCardPlacement | null) => void
) => void

/** Open, measure, animate and dismiss state for an AnchoredDetailCard; any change to `geometry`
 *  closes it, while a change to `follow` moves an open card to its anchor's new place. */
export function useAnchoredDetailCard({
  geometry: placementGeometry = '',
  follow = '',
  obscured,
  measure
}: {
  geometry?: string
  follow?: string
  obscured: boolean
  measure: DetailCardMeasure
}) {
  const layerRef = useRef<View>(null)
  const openerRef = useRef<View>(null)
  const contentRef = useRef<View>(null)
  const backRef = useRef<View>(null)
  const boundaryRefs = useRef<unknown[]>([])
  const measureRef = useRef(measure)
  useLayoutEffect(() => {
    measureRef.current = measure
  }, [measure])
  const [state, dispatch] = useReducer(reduce, {
    serial: 0,
    request: null,
    visual: null
  })
  const [size, setSize] = useState({ width: 0, height: 0 })
  const window = useWindowDimensions()
  const insets = useWindowSafeAreaInsets()
  const { top, left, right } = insets
  const generation = useRef(0)
  const geometry = [window.width, top, left, right, size.width, placementGeometry].join(':')
  const dismiss = useCallback(() => dispatch({ type: 'close' }), [])
  const onSettled = useCallback((motion: number) => dispatch({ type: 'settled', motion }), [])
  const toggle = useCallback(() => dispatch({ type: 'toggle', eligible: !obscured }), [obscured])
  const onAnchorLayout = useCallback(() => {
    generation.current += 1
    dismiss()
  }, [dismiss])
  useLayoutEffect(() => {
    dismiss()
    return () => {
      generation.current += 1
    }
  }, [dismiss, geometry, obscured])
  // Calls back with null when the card's views are gone.
  const measureAnchor = useCallback(
    (done: (anchor: DetailCardAnchor | null) => void): (() => void) => {
      const layer = layerRef.current
      if (!layer) {
        done(null)
        return () => {}
      }
      let disposed = false
      const current = generation.current
      layer.measureInWindow((rootX, rootY) => {
        measureRef.current({ x: rootX, y: rootY }, (placement) => {
          if (!disposed && current === generation.current) {
            done(placement && { ...placement, origin: { x: rootX, y: rootY } })
          }
        })
      })
      return () => {
        disposed = true
      }
    },
    []
  )
  const request = state.request
  useLayoutEffect(() => {
    if (request === null || obscured) {
      return
    }
    return measureAnchor((anchor) =>
      dispatch(anchor ? { type: 'measured', request, anchor } : { type: 'close', request })
    )
  }, [request, geometry, obscured, measureAnchor])
  const shown = state.visual?.target === 1 && !obscured
  // A height-only resize (split screen) moves a bottom anchor too.
  const followKey = [follow, window.height, size.height].join(':')
  const followed = useRef(followKey)
  useLayoutEffect(() => {
    if (followed.current === followKey) {
      return
    }
    followed.current = followKey
    if (!shown) {
      return
    }
    return measureAnchor((anchor) =>
      dispatch(anchor ? { type: 'moved', anchor } : { type: 'close' })
    )
  }, [followKey, shown, measureAnchor])
  const onLayout = useCallback((event: LayoutChangeEvent) => {
    setSize(event.nativeEvent.layout)
  }, [])
  const { visual } = state
  const requestedOpen = request !== null || visual?.target === 1
  const closeFirst = () => {
    if (!requestedOpen || obscured) {
      return false
    }
    dismiss()
    return true
  }
  useBackClaim(requestedOpen && !obscured ? closeFirst : null)
  const origin = visual?.anchor.origin ?? { x: 0, y: 0 }
  return {
    layerRef,
    openerRef,
    contentRef,
    backRef,
    boundaryRefs,
    closeFirst,
    active: visual?.target === 1 && !obscured,
    visual,
    requestedOpen,
    present: visual !== null,
    dismiss,
    onSettled,
    onLayout,
    onAnchorLayout,
    toggle,
    layerHeight: size.height,
    bounds: {
      left: Math.max(0, insets.left - origin.x),
      top: Math.max(0, insets.top - origin.y),
      right: Math.min(size.width, window.width - insets.right - origin.x),
      bottom: Math.min(size.height, window.height - insets.bottom - origin.y)
    }
  }
}

export type AnchoredDetailCardState = ReturnType<typeof useAnchoredDetailCard>
