import { useLayoutEffect, useRef, type RefObject } from 'react'
import {
  decideTitlebarChromeFold,
  getTitlebarChromeFoldLevel,
  getTitlebarChromeMeasurementLevel,
  setTitlebarChromeFoldLevel,
  setTitlebarChromeMeasurementLevel,
  useTitlebarHeaderFoldLevel,
  useTitlebarChromeOwnerStrip,
  type TitlebarChromeFoldLevel
} from './titlebar-chrome-fold'

/** Single writer of the fold level: watches the owner pane's strip and the floating header. */
export function useTitlebarChromeFoldObserver({
  active,
  controlsRef,
  headerShapeKey,
  layoutHeaderWidth
}: {
  /** The header floats over the top-left pane (left sidebar collapsed, workspace chrome shown). */
  active: boolean
  controlsRef: RefObject<HTMLDivElement | null>
  /** Changes when the header's non-folding contents change (full screen, app name, view). */
  headerShapeKey: string
  /** The header width that the shell has applied to the pane's spacer. */
  layoutHeaderWidth: number
}): void {
  const ownerStrip = useTitlebarChromeOwnerStrip()
  const headerLevel = useTitlebarHeaderFoldLevel()
  const headerWidthByLevelRef = useRef<Partial<Record<TitlebarChromeFoldLevel, number>>>({})

  // Cached widths of other levels are stale now and folded parts can't be measured, so re-measure
  // from full chrome (this layout pass, before paint) rather than guess.
  const shapeKeyRef = useRef(headerShapeKey)
  useLayoutEffect(() => {
    if (shapeKeyRef.current === headerShapeKey) {
      return
    }
    shapeKeyRef.current = headerShapeKey
    headerWidthByLevelRef.current = {}
    // Only the measured header unfolds. The pane keeps its controls and focus until the new level is settled.
    setTitlebarChromeMeasurementLevel(0)
  }, [headerShapeKey])

  useLayoutEffect(() => {
    const controls = controlsRef.current
    if (!active || !ownerStrip || !controls) {
      setTitlebarChromeFoldLevel(0)
      return undefined
    }
    const evaluate = (): void => {
      const strip = ownerStrip.getBoundingClientRect().width
      if (strip === 0) {
        return
      }
      const committed = getTitlebarChromeFoldLevel()
      const measurement = getTitlebarChromeMeasurementLevel()
      const current = measurement ?? committed
      if (headerLevel !== current || controls.dataset.titlebarFoldLevel !== String(current)) {
        return
      }
      const header = controls.getBoundingClientRect().width
      if (Math.abs(header - layoutHeaderWidth) > 0.5) {
        return
      }
      const cache = headerWidthByLevelRef.current
      cache[current] = header
      const next = decideTitlebarChromeFold({
        previous: current,
        stripWidth: strip,
        headerWidth: header,
        foldableWidthTo: (level) => measureFoldableWidth(controls, current, level),
        cachedHeaderWidths: cache,
        hysteresisFrom: committed
      })
      if (measurement === 0 && next === 1) {
        setTitlebarChromeMeasurementLevel(1)
        return
      }
      setTitlebarChromeFoldLevel(next)
    }
    evaluate()
    const observer = new ResizeObserver(evaluate)
    observer.observe(ownerStrip)
    observer.observe(controls)
    return () => observer.disconnect()
  }, [active, ownerStrip, controlsRef, headerLevel, headerShapeKey, layoutHeaderWidth])

  useLayoutEffect(() => () => setTitlebarChromeFoldLevel(0), [])
}

/** Width the header loses going from `from` to `to`: visible parts tagged with a step in between. */
function measureFoldableWidth(controls: HTMLElement, from: number, to: number): number {
  const inRange = (element: Element | null | undefined): element is HTMLElement => {
    if (!(element instanceof HTMLElement)) {
      return false
    }
    const step = Number(element.dataset.titlebarFoldStep)
    return step > from && step <= to
  }
  let total = 0
  for (const element of controls.querySelectorAll<HTMLElement>('[data-titlebar-fold-step]')) {
    // A nested part folds with its parent; count the parent once.
    if (!inRange(element) || inRange(element.parentElement?.closest('[data-titlebar-fold-step]'))) {
      continue
    }
    const style = getComputedStyle(element)
    total +=
      element.getBoundingClientRect().width +
      (Number.parseFloat(style.marginLeft) || 0) +
      (Number.parseFloat(style.marginRight) || 0)
  }
  return total
}
