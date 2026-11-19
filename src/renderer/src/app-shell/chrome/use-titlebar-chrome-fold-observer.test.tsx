// @vitest-environment happy-dom

import { useEffect, useLayoutEffect, useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import {
  getTitlebarChromeFoldLevel,
  registerTitlebarChromeOwnerStrip,
  useTitlebarChromeFoldLevel
} from './titlebar-chrome-fold'
import { useTitlebarChromeFoldObserver } from './use-titlebar-chrome-fold-observer'

// Mac header: 112px base (traffic lights 70 + sidebar toggle) + Back 42 (step 2) + "Orca"/Forward 66 (step 1).
// Full screen hides the traffic lights.
const BASE_PX = { windowed: 112, fullScreen: 42 }
let paneWidth = 0
let fullScreen = false
const resizeCallbacks = new Set<() => void>()
const levels: number[] = []

function width(element: HTMLElement): number {
  if (element.dataset.testHeader !== undefined) {
    const parts = [...element.querySelectorAll<HTMLElement>('[data-titlebar-fold-step]')]
    return (
      (fullScreen ? BASE_PX.fullScreen : BASE_PX.windowed) +
      parts.reduce((sum, part) => sum + Number(part.dataset.testWidth), 0)
    )
  }
  if (element.dataset.testStrip !== undefined) {
    return paneWidth - width(document.querySelector<HTMLElement>('[data-test-header]')!)
  }
  return Number(element.dataset.testWidth ?? 0)
}

beforeEach(() => {
  levels.length = 0
  resizeCallbacks.clear()
  vi.stubGlobal(
    'ResizeObserver',
    class {
      private callback: () => void
      constructor(callback: () => void) {
        this.callback = callback
        resizeCallbacks.add(callback)
      }
      observe(): void {}
      disconnect(): void {
        resizeCallbacks.delete(this.callback)
      }
    }
  )
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement
  ) {
    return new DOMRect(0, 0, width(this), 0)
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function Shell({ shapeKey }: { shapeKey: string }): React.JSX.Element {
  const controlsRef = useRef<HTMLDivElement>(null)
  const stripRef = useRef<HTMLDivElement>(null)
  const level = useTitlebarChromeFoldLevel()
  useEffect(() => {
    levels.push(level)
  }, [level])
  useLayoutEffect(() => registerTitlebarChromeOwnerStrip(stripRef.current!), [])
  useTitlebarChromeFoldObserver({ active: true, controlsRef, headerShapeKey: shapeKey })
  return (
    <>
      <div ref={controlsRef} data-test-header="">
        {level < 2 ? <span data-titlebar-fold-step="2" data-test-width="42" /> : null}
        {level < 1 ? <span data-titlebar-fold-step="1" data-test-width="66" /> : null}
      </div>
      <div ref={stripRef} data-test-strip="" />
    </>
  )
}

/** Delivers resize events until the level stops changing, as layout would. */
function settleResizes(): void {
  for (let i = 0; i < 6; i++) {
    act(() => resizeCallbacks.forEach((callback) => callback()))
  }
}

/** Window resizes land first, then the header-shape change; returns the levels from the reset on. */
function changeHeaderShape(
  rerender: (ui: React.JSX.Element) => void,
  shape: { fullScreen: boolean; view: string }
): number[] {
  fullScreen = shape.fullScreen
  settleResizes()
  const from = levels.length
  act(() => rerender(<Shell shapeKey={`${shape.fullScreen}|${shape.view}`} />))
  settleResizes()
  return levels.slice(from)
}

function mount(pane: number, approachFrom = pane): (ui: React.JSX.Element) => void {
  fullScreen = false
  paneWidth = approachFrom
  const { rerender } = render(<Shell shapeKey="false|terminal" />)
  settleResizes()
  paneWidth = pane
  settleResizes()
  return rerender
}

/** A reset shows full chrome at most once, then refolds in one move; later resizes change nothing. */
/** After a reset to full chrome, the level only refolds forward (one step per reading) to `end`. */
function expectSingleRefold(run: number[], end: number): void {
  expect(run.length).toBeLessThanOrEqual(3)
  if (run.length > 1) {
    expect(run[0]).toBe(0)
  }
  run.slice(1).forEach((level, index) => expect(level).toBe(run[index]! + 1))
  expect(getTitlebarChromeFoldLevel()).toBe(end)
  const after = levels.length
  settleResizes()
  expect(levels.length).toBe(after)
}

describe('useTitlebarChromeFoldObserver header-shape reset', () => {
  it('toggling full screen at a narrow width refolds forward without back-and-forth and ends where it started', () => {
    // Strip 110 at full chrome and 176 at step 1: step 2 windowed, step 1 in full screen.
    const rerender = mount(330)
    expect(getTitlebarChromeFoldLevel()).toBe(2)
    expectSingleRefold(changeHeaderShape(rerender, { fullScreen: true, view: 'terminal' }), 1)
    expectSingleRefold(changeHeaderShape(rerender, { fullScreen: false, view: 'terminal' }), 2)
  })

  it('keeps a folded level held by hysteresis across a reset', () => {
    // Widening to a 332px full-chrome strip stays inside step 1's 330–337 deadband.
    const rerender = mount(552, 540)
    expect(getTitlebarChromeFoldLevel()).toBe(1)
    expectSingleRefold(changeHeaderShape(rerender, { fullScreen: false, view: 'settings' }), 1)
  })
})
