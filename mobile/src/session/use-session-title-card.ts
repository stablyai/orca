import { useCallback, useLayoutEffect, useReducer, useRef, useState } from 'react'
import type { ComponentRef } from 'react'
import { type Text, useWindowDimensions, type LayoutChangeEvent, type View } from 'react-native'
import type { DetailCardAnchor } from '../components/AnchoredDetailCard'
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
  const backRef = useRef<View>(null)
  const boundaryRefs = useRef<unknown[]>([])
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
  const geometry = [window.width, top, left, right, besideTabs, size.width].join(':')
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
    barRef,
    titleRef,
    openerRef,
    contentRef,
    backRef,
    boundaryRefs,
    closeFirst,
    active: visual?.target === 1 && !obscured,
    visual,
    requestedOpen,
    present: visual !== null,
    besideTabs,
    dismiss,
    onSettled,
    onLayout,
    onAnchorLayout,
    toggle,
    bounds: {
      left: Math.max(0, insets.left - origin.x),
      top: Math.max(0, insets.top - origin.y),
      right: Math.min(size.width, window.width - insets.right - origin.x),
      bottom: Math.min(size.height, window.height - insets.bottom - origin.y)
    }
  }
}

export type SessionTitleCard = ReturnType<typeof useSessionTitleCard>
