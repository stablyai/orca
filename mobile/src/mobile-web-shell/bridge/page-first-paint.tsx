import {
  createContext,
  useContext,
  useEffect,
  type ComponentType,
  type PropsWithChildren,
  type ReactElement
} from 'react'

export type PageFrameScheduler = {
  readonly requestFrame: (callback: () => void) => number
  readonly cancelFrame: (handle: number) => void
}

// Wait two animation frames: the first callback can precede the committed DOM’s paint, uncovering an undrawn tree. Return cancellation for any report still owed.
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
  // Free the latch only if cancellation reclaimed an undelivered report; a delivered report cannot be spent twice.
  return () => {
    if (settled) {
      return false
    }
    settled = true
    scheduler.cancelFrame(handle)
    return true
  }
}

// Default to no report for native/unit trees, which have no shell cover to release.
const RouteScreenPaintContext = createContext<RouteScreenPaintReporter>(() => () => undefined)

export type RouteScreenPaintReporter = () => () => void

// Report once per document only after posting; cancelled/replaced screens leave that opportunity to the screen that ultimately paints.
export function createRouteScreenPaintReporter(
  scheduler: PageFrameScheduler,
  post: () => void
): RouteScreenPaintReporter {
  let posted = false
  let owed: (() => boolean) | null = null
  return () => {
    if (posted) {
      return () => undefined
    }
    // Newest commit takes over a pending report; the earlier screen may remain mounted underneath.
    owed?.()
    const cancel = reportAfterFirstPaint(scheduler, () => {
      owed = null
      posted = true
      post()
    })
    owed = cancel
    return () => {
      cancel()
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

// Report at resolved route chunks, not the wrapper above suspense, whose empty fallback commit would uncover a blank body.
export function withRouteScreenPaintReport(module: {
  readonly default: ComponentType<Record<string, unknown>>
}): { default: ComponentType<Record<string, unknown>> } {
  const Screen = module.default
  function RouteScreenPaintReport(props: Record<string, unknown>): ReactElement {
    const report = useContext(RouteScreenPaintContext)
    // Cancel on route replacement before its frame; stale cleanup must not uncover the new fallback.
    useEffect(() => report(), [report])
    return <Screen {...props} />
  }
  return { default: RouteScreenPaintReport }
}
