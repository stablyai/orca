import { useCallback, useLayoutEffect, useReducer, useRef, useState, type RefObject } from 'react'
import { useWindowDimensions, type LayoutChangeEvent, type View } from 'react-native'
import type { DetailCardAnchor } from './AnchoredDetailCard'
import { useBackClaim } from '../navigation/use-back-claim'
import { useWindowSafeAreaInsets } from '../layout/side-safe-area'

export type DetailCardSource = {
  key: string
  anchorRef: RefObject<Pick<View, 'measureInWindow'> | null>
  barRef: RefObject<View | null>
  openerRef: RefObject<View | null>
  geometry: 'dismiss' | 'refresh'
}
type Request = { id: number; source: DetailCardSource }
type Visual = { anchor: DetailCardAnchor; target: 0 | 1; motion: number; source: DetailCardSource }
type State = { serial: number; request: Request | null; visual: Visual | null }
type MeasureAnchor = (source: DetailCardSource) => DetailCardAnchor | null
type Action =
  | { type: 'toggle'; eligible: boolean; source: DetailCardSource }
  | { type: 'close'; request?: number }
  | { type: 'remove'; key: string }
  | { type: 'refresh'; source?: DetailCardSource; measure?: MeasureAnchor }
  | { type: 'geometry'; measure?: MeasureAnchor }
  | { type: 'measured'; request: number; anchor: DetailCardAnchor }
  | { type: 'settled'; motion: number }

function measureDomAnchor(
  layer: unknown,
  source: DetailCardSource,
  sources: Map<string, DetailCardSource>
): DetailCardAnchor | null {
  const anchor = source.anchorRef.current
  const bar = source.barRef.current
  if (
    sources.get(source.key) !== source ||
    typeof HTMLElement === 'undefined' ||
    !(layer instanceof HTMLElement) ||
    !(anchor instanceof HTMLElement) ||
    !(bar instanceof HTMLElement)
  ) {
    return null
  }
  const rootRect = layer.getBoundingClientRect()
  const anchorRect = anchor.getBoundingClientRect()
  const barRect = bar.getBoundingClientRect()
  return {
    trigger: {
      x: anchorRect.left - rootRect.left,
      y: anchorRect.top - rootRect.top,
      width: anchorRect.width,
      height: anchorRect.height
    },
    top: barRect.top + barRect.height - rootRect.top,
    origin: { x: rootRect.left, y: rootRect.top }
  }
}

function applyAnchor(state: State, source: DetailCardSource, anchor: DetailCardAnchor): State {
  const { visual, request, serial } = state
  if (
    request === null &&
    visual?.target === 1 &&
    visual.source === source &&
    visual.anchor.top === anchor.top &&
    visual.anchor.origin.x === anchor.origin.x &&
    visual.anchor.origin.y === anchor.origin.y &&
    visual.anchor.trigger.x === anchor.trigger.x &&
    visual.anchor.trigger.y === anchor.trigger.y &&
    visual.anchor.trigger.width === anchor.trigger.width &&
    visual.anchor.trigger.height === anchor.trigger.height
  ) {
    return state
  }
  return {
    serial: serial + 1,
    request: null,
    visual: {
      anchor,
      source,
      target: 1,
      // Reposition an open card without restarting its entry animation.
      motion: visual?.target === 1 && visual.source.key === source.key ? visual.motion : serial + 1
    }
  }
}

function reduce(state: State, action: Action): State {
  const { visual, request, serial } = state
  const source = request?.source ?? (visual?.target === 1 ? visual.source : null)
  switch (action.type) {
    case 'toggle':
      if (!action.eligible) {
        return state
      }
      return source?.key === action.source.key
        ? reduce(state, { type: 'close' })
        : { ...state, serial: serial + 1, request: { id: serial + 1, source: action.source } }
    case 'geometry':
      return source?.geometry === 'refresh'
        ? reduce(state, { type: 'refresh', measure: action.measure })
        : reduce(state, { type: 'close' })
    case 'refresh': {
      if (
        !source ||
        (!action.source && source.geometry !== 'refresh') ||
        (action.source && action.source.key !== source.key)
      ) {
        return state
      }
      const nextSource = action.source ?? source
      const anchor = action.measure?.(nextSource)
      return anchor
        ? applyAnchor(state, nextSource, anchor)
        : { ...state, serial: serial + 1, request: { id: serial + 1, source: nextSource } }
    }
    case 'remove':
      return source?.key === action.key
        ? reduce(state, { type: 'close' })
        : visual?.source.key === action.key
          ? { ...state, visual: null }
          : state
    case 'close':
      if (action.request !== undefined && action.request !== request?.id) {
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
    case 'measured':
      return action.request === request?.id
        ? applyAnchor(state, request.source, action.anchor)
        : state
    case 'settled':
      return visual?.target === 0 && visual.motion === action.motion
        ? { ...state, visual: null }
        : state
  }
}

export function useAnchoredDetailCard(placement: string, obscured: boolean) {
  const layerRef = useRef<View>(null)
  const contentRef = useRef<View>(null)
  const backRef = useRef<View>(null)
  const boundaryRefs = useRef<unknown[]>([])
  const sources = useRef(new Map<string, DetailCardSource>())
  const [state, dispatch] = useReducer(reduce, { serial: 0, request: null, visual: null })
  const [size, setSize] = useState({ width: 0, height: 0 })
  const window = useWindowDimensions()
  const insets = useWindowSafeAreaInsets()
  const geometry = [
    window.width,
    insets.top,
    insets.left,
    insets.right,
    placement,
    size.width
  ].join(':')
  const dismiss = useCallback(() => dispatch({ type: 'close' }), [])
  const removeSource = useCallback((key: string) => dispatch({ type: 'remove', key }), [])
  const onSettled = useCallback((motion: number) => dispatch({ type: 'settled', motion }), [])
  const toggleSource = useCallback(
    (source: DetailCardSource) => dispatch({ type: 'toggle', source, eligible: !obscured }),
    [obscured]
  )
  const measure = useCallback(
    (source: DetailCardSource) => measureDomAnchor(layerRef.current, source, sources.current),
    []
  )
  const refreshSource = useCallback(
    (source?: DetailCardSource) => dispatch({ type: 'refresh', source, measure }),
    [measure]
  )
  const onAnchorLayout = useCallback(() => dispatch({ type: 'geometry', measure }), [measure])
  const registerSource = useCallback(
    (source: DetailCardSource) => {
      sources.current.set(source.key, source)
      refreshSource(source)
      return () => {
        if (sources.current.get(source.key) === source) {
          sources.current.delete(source.key)
          refreshSource(source)
        }
      }
    },
    [refreshSource]
  )
  useLayoutEffect(() => {
    if (obscured) {
      dismiss()
    } else {
      onAnchorLayout()
    }
  }, [dismiss, onAnchorLayout, geometry, obscured])
  const { request, visual } = state
  useLayoutEffect(() => {
    if (!request || obscured) {
      return
    }
    const { source, id } = request
    const layer = layerRef.current
    const anchor = source.anchorRef.current
    const bar = source.barRef.current
    if (!layer || !anchor || !bar || sources.current.get(source.key) !== source) {
      // A tab may be between placements during rotation; attachment resumes its request.
      if (source.geometry === 'dismiss') {
        dispatch({ type: 'close', request: id })
      }
      return
    }
    const domAnchor = measureDomAnchor(layer, source, sources.current)
    if (domAnchor) {
      dispatch({ type: 'measured', request: id, anchor: domAnchor })
      return
    }
    let disposed = false
    layer.measureInWindow((rootX, rootY) => {
      anchor.measureInWindow((x, y, width, height) => {
        bar.measureInWindow((_x, barY, _width, barHeight) => {
          if (
            !disposed &&
            sources.current.get(source.key) === source &&
            source.anchorRef.current === anchor
          ) {
            dispatch({
              type: 'measured',
              request: id,
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
  }, [request, obscured])
  const onLayout = useCallback((event: LayoutChangeEvent) => setSize(event.nativeEvent.layout), [])
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
    contentRef,
    backRef,
    boundaryRefs,
    closeFirst,
    active: visual?.target === 1 && !obscured,
    visual,
    requestedOpen,
    requestedKey: request?.source.key ?? (visual?.target === 1 ? visual.source.key : null),
    present: visual !== null,
    dismiss,
    removeSource,
    onSettled,
    onLayout,
    onAnchorLayout,
    toggleSource,
    refreshSource,
    registerSource,
    bounds: {
      left: Math.max(0, insets.left - origin.x),
      top: Math.max(0, insets.top - origin.y),
      right: Math.min(size.width, window.width - insets.right - origin.x),
      bottom: Math.min(size.height, window.height - insets.bottom - origin.y)
    }
  }
}

export type AnchoredDetailCardController = ReturnType<typeof useAnchoredDetailCard>

export function useDetailCardSource(
  controller: Pick<AnchoredDetailCardController, 'registerSource'>,
  source: DetailCardSource
) {
  const { registerSource } = controller
  useLayoutEffect(() => registerSource(source), [registerSource, source])
}
