import {
  createContext,
  useContext,
  useEffect,
  type ComponentType,
  type PropsWithChildren,
  type ReactElement
} from 'react'

/** How the page schedules one frame. `requestAnimationFrame` on a document, a fake in a test. */
export type PageFrameScheduler = (callback: () => void) => void

/**
 * Calls `report` once the browser has painted the commit this was scheduled from. Two frames, not
 * one: an effect runs with the DOM mutated and the frame not yet painted, so the first callback
 * scheduled from it can still run ahead of that paint. Being late costs one frame of a cover that
 * is already up; being early uncovers the view over a tree nothing has drawn.
 */
export function reportAfterFirstPaint(schedule: PageFrameScheduler, report: () => void): void {
  schedule(() => {
    schedule(report)
  })
}

/**
 * How a route screen says it committed. Defaulted to nothing: these screens also render natively
 * and in unit trees, where no shell is holding a frame over them.
 */
const RouteScreenPaintContext = createContext<() => void>(() => undefined)

export function RouteScreenPaintProvider({
  report,
  children
}: PropsWithChildren<{ report: () => void }>): ReactElement {
  return (
    <RouteScreenPaintContext.Provider value={report}>{children}</RouteScreenPaintContext.Provider>
  )
}

/**
 * The screen behind a deferred route, reporting the commit that drew it. Applied where the route
 * manifest resolves the chunk, because the wrapper above the router commits with the suspense
 * fallback while that chunk is still arriving, and a report scheduled there uncovers the shell's
 * view over an empty body.
 */
export function withRouteScreenPaintReport(module: {
  readonly default: ComponentType<Record<string, unknown>>
}): { default: ComponentType<Record<string, unknown>> } {
  const Screen = module.default
  function RouteScreenPaintReport(props: Record<string, unknown>): ReactElement {
    const report = useContext(RouteScreenPaintContext)
    useEffect(() => {
      report()
    }, [report])
    return <Screen {...props} />
  }
  return { default: RouteScreenPaintReport }
}
