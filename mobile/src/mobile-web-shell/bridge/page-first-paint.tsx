import {
  createContext,
  useContext,
  useEffect,
  type ComponentType,
  type PropsWithChildren,
  type ReactElement
} from 'react'

/** How the page schedules one frame. `requestAnimationFrame` on a document, a fake in a test. */
export type PageFrameScheduler = {
  readonly requestFrame: (callback: () => void) => number
  readonly cancelFrame: (handle: number) => void
}

/**
 * Calls `report` once the browser has painted the commit this was scheduled from, and answers with
 * the cancel for the frame still owed. Two frames, not one: an effect runs with the DOM mutated and
 * the frame not yet painted, so the first callback scheduled from it can still run ahead of that
 * paint. Being early uncovers the view over a tree nothing has drawn.
 */
export function reportAfterFirstPaint(
  scheduler: PageFrameScheduler,
  report: () => void
): () => boolean {
  let settled = false
  let handle = scheduler.requestFrame(() => {
    handle = scheduler.requestFrame(() => {
      settled = true
      report()
    })
  })
  // Answers whether it took a report back, which is the only thing that frees a caller's latch: a
  // report already delivered is not one the next screen gets to spend again.
  return () => {
    if (settled) {
      return false
    }
    settled = true
    scheduler.cancelFrame(handle)
    return true
  }
}

/**
 * How a route screen says it committed. Defaulted to nothing: these screens also render natively
 * and in unit trees, where no shell is holding a frame over them.
 */
const RouteScreenPaintContext = createContext<RouteScreenPaintReporter>(() => () => undefined)

/** Reports one screen's commit and answers with the take-back for the frame it is still owed. */
export type RouteScreenPaintReporter = () => () => void

/**
 * The page's one reporter. Once per document, because the shell latches the first frame and a
 * navigation to a second screen is not a new thing to uncover — but a report taken back before it
 * landed was never spent, so the screen that arrives next still gets to make it.
 */
export function createRouteScreenPaintReporter(
  scheduler: PageFrameScheduler,
  post: () => void
): RouteScreenPaintReporter {
  let reported = false
  return () => {
    if (reported) {
      return () => undefined
    }
    reported = true
    const cancel = reportAfterFirstPaint(scheduler, post)
    return () => {
      if (cancel()) {
        reported = false
      }
    }
  }
}

export function RouteScreenPaintProvider({
  report,
  children
}: PropsWithChildren<{ report: RouteScreenPaintReporter }>): ReactElement {
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
    // Returned as the cleanup: a route swapped out before its frame lands would otherwise uncover
    // the view on the way out, over the fallback of whatever replaced it.
    useEffect(() => report(), [report])
    return <Screen {...props} />
  }
  return { default: RouteScreenPaintReport }
}
