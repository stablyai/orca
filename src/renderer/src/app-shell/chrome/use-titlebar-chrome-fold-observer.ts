import { useLayoutEffect, useRef, type RefObject } from 'react'
import {
  decideTitlebarChromeFold,
  getTitlebarChromeFoldLevel,
  setTitlebarChromeFoldLevel,
  useTitlebarChromeOwnerStrip,
  type TitlebarChromeFoldLevel
} from './titlebar-chrome-fold'

/** Single writer of the fold level: watches the owner pane's strip and the floating header. */
export function useTitlebarChromeFoldObserver({
  active,
  controlsRef,
  headerShapeKey
}: {
  /** The header floats over the top-left pane (left sidebar collapsed, workspace chrome shown). */
  active: boolean
  controlsRef: RefObject<HTMLDivElement | null>
  /** Changes when the header's non-folding contents change (full screen, app name, view). */
  headerShapeKey: string
}): void {
  const ownerStrip = useTitlebarChromeOwnerStrip()
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
    setTitlebarChromeFoldLevel(0)
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
      const current = getTitlebarChromeFoldLevel()
      const header = controls.getBoundingClientRect().width
      const cache = headerWidthByLevelRef.current
      cache[current] = header
      setTitlebarChromeFoldLevel(
        decideTitlebarChromeFold({
          previous: current,
          stripWidth: strip,
          headerWidth: header,
          foldableWidthTo: (level) => measureFoldableWidth(controls, current, level),
          cachedHeaderWidths: cache
        })
      )
    }
    evaluate()
    const observer = new ResizeObserver(evaluate)
    observer.observe(ownerStrip)
    observer.observe(controls)
    return () => observer.disconnect()
  }, [active, ownerStrip, controlsRef])

  useLayoutEffect(() => () => setTitlebarChromeFoldLevel(0), [])
}

/** Width the header loses going from `from` to `to`: visible parts tagged with a step in between. */
function measureFoldableWidth(controls: HTMLElement, from: number, to: number): number {
  const inRange = (element: Element | null): element is HTMLElement => {
    const step = Number((element as HTMLElement | null)?.dataset?.titlebarFoldStep)
    return step > from && step <= to
  }
  let total = 0
  for (const element of controls.querySelectorAll<HTMLElement>('[data-titlebar-fold-step]')) {
    // A nested part folds with its parent; count the parent once.
    if (
      !inRange(element) ||
      inRange(element.parentElement?.closest('[data-titlebar-fold-step]') ?? null)
    ) {
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
