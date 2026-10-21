import { useCallback, useLayoutEffect, useReducer, useRef, useState } from 'react'
import type { ComponentRef } from 'react'
import {
  type Text,
  useWindowDimensions,
  type LayoutChangeEvent,
  type LayoutRectangle,
  type View
} from 'react-native'
import type { DetailCardAnchor } from '../components/AnchoredDetailCard'
import { useWindowSafeAreaInsets } from '../layout/side-safe-area'

type State = {
  serial: number
  request: number | null
  visual: { anchor: DetailCardAnchor; target: 0 | 1; motion: number } | null
  titleBounds: LayoutRectangle
}
type Action =
  | { type: 'toggle'; eligible: boolean }
  | { type: 'close'; request?: number }
  | { type: 'measured'; request: number; anchor: DetailCardAnchor }
  | { type: 'hole'; bounds: LayoutRectangle }
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
        visual: { anchor, target: 1, motion: serial + 1 },
        titleBounds: {
          ...anchor.trigger,
          x: anchor.trigger.x + anchor.origin.x,
          y: anchor.trigger.y + anchor.origin.y
        }
      }
    }
    case 'hole':
      return { ...state, titleBounds: action.bounds }
    case 'settled':
      return visual?.target === 0 && visual.motion === action.motion
        ? { ...state, visual: null }
        : state
  }
}

export function useSessionTitleCard(besideTabs: boolean, obscured: boolean) {
  const layerRef = useRef<View>(null)
  const barRef = useRef<View>(null)
  const titleRef = useRef<ComponentRef<typeof Text>>(null)
  const openerRef = useRef<View>(null)
  const contentRef = useRef<View>(null)
  const [state, dispatch] = useReducer(reduce, {
    serial: 0,
    request: null,
    visual: null,
    titleBounds: { x: 0, y: 0, width: 0, height: 0 }
  })
  const [size, setSize] = useState({ width: 0, height: 0 })
  const window = useWindowDimensions()
  const insets = useWindowSafeAreaInsets()
  const { top, left, right } = insets
  const generation = useRef(0)
  const geometry = [window.width, top, left, right, besideTabs, size.width].join(':')
  const dismiss = useCallback(() => dispatch({ type: 'close' }), [])
  const onSettled = useCallback((motion: number) => dispatch({ type: 'settled', motion }), [])
  const toggle = useCallback(() => dispatch({ type: 'toggle', eligible: !obscured }), [obscured])
  const onAnchorLayout = useCallback(() => {
    const current = ++generation.current
    dismiss()
    titleRef.current?.measureInWindow((x, y, width, height) => {
      if (current === generation.current) {
        dispatch({ type: 'hole', bounds: { x, y, width, height } })
      }
    })
  }, [dismiss])
  useLayoutEffect(() => {
    dismiss()
    return () => {
      generation.current += 1
    }
  }, [dismiss, geometry, obscured])
  const request = state.request
  useLayoutEffect(() => {
    if (request === null || obscured) {
      return
    }
    const layer = layerRef.current
    const title = titleRef.current
    const bar = barRef.current
    if (!layer || !title || !bar) {
      dispatch({ type: 'close', request })
      return
    }
    let disposed = false
    const current = generation.current
    layer.measureInWindow((rootX, rootY) => {
      title.measureInWindow((x, y, width, height) => {
        bar.measureInWindow((_x, barY, _width, barHeight) => {
          if (!disposed && current === generation.current) {
            dispatch({
              type: 'measured',
              request,
              anchor: {
                trigger: { x: x - rootX, y: y - rootY, width, height },
                top: barY + barHeight - rootY,
                origin: { x: rootX, y: rootY }
              }
            })
          }
        })
      })
    })
    return () => {
      disposed = true
    }
  }, [request, geometry, obscured])
  const onLayout = useCallback((event: LayoutChangeEvent) => {
    setSize(event.nativeEvent.layout)
  }, [])
  const { visual, titleBounds } = state
  const origin = visual?.anchor.origin ?? { x: 0, y: 0 }
  return {
    layerRef,
    barRef,
    titleRef,
    openerRef,
    contentRef,
    visual,
    trigger: { ...titleBounds, x: titleBounds.x - origin.x, y: titleBounds.y - origin.y },
    requestedOpen: request !== null || visual?.target === 1,
    present: visual !== null,
    besideTabs,
    dismiss,
    onSettled,
    onLayout,
    onAnchorLayout,
    toggle,
    viewport: { x: -origin.x, y: -origin.y, width: window.width, height: window.height },
    bounds: {
      left: Math.max(0, insets.left - origin.x),
      top: Math.max(0, insets.top - origin.y),
      right: Math.min(size.width, window.width - insets.right - origin.x),
      bottom: Math.min(size.height, window.height - insets.bottom - origin.y)
    }
  }
}

export type SessionTitleCard = ReturnType<typeof useSessionTitleCard>
