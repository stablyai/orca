import { Suspense, lazy, useEffect, type ComponentType, type PropsWithChildren } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it } from 'vitest'
import {
  RouteScreenPaintProvider,
  createRouteScreenPaintReporter,
  reportAfterFirstPaint,
  withRouteScreenPaintReport
} from './page-first-paint'

/** Frames the caller drains by hand, so "one frame later" is a step rather than a wait. */
function frames() {
  const queued = new Map<number, () => void>()
  let nextHandle = 0
  return {
    scheduler: {
      requestFrame: (callback: () => void) => {
        nextHandle += 1
        queued.set(nextHandle, callback)
        return nextHandle
      },
      cancelFrame: (handle: number) => {
        queued.delete(handle)
      }
    },
    tick: () => {
      const [handle, callback] = queued.entries().next().value ?? []
      if (handle !== undefined) {
        queued.delete(handle)
        callback?.()
      }
    },
    pending: () => queued.size
  }
}

describe('when the page says it has a frame', () => {
  it('waits for a frame boundary past the commit, never the same one', () => {
    // One frame is the frame that paints the commit, and a callback inside it can still run ahead
    // of the paint. Reporting there would uncover the view over a tree nothing has drawn.
    const clock = frames()
    let reported = 0
    reportAfterFirstPaint(clock.scheduler, () => {
      reported += 1
    })
    expect(reported).toBe(0)
    clock.tick()
    expect(reported).toBe(0)
    clock.tick()
    expect(reported).toBe(1)
  })

  it('reports once and schedules nothing after it', () => {
    const clock = frames()
    reportAfterFirstPaint(clock.scheduler, () => {})
    clock.tick()
    clock.tick()
    expect(clock.pending()).toBe(0)
  })
})

/** A route chunk the case releases by hand, so "still arriving" is a state and not a race. */
function deferredRouteChunk() {
  let arrive: (() => void) | null = null
  const chunk = new Promise<{ default: ComponentType<Record<string, unknown>> }>((resolve) => {
    arrive = () => {
      resolve({ default: () => null })
    }
  })
  return {
    chunk,
    arrive: () => {
      arrive?.()
    }
  }
}

describe('a route that leaves before its frame lands', () => {
  it('takes its report back, so the shell never uncovers on a screen that went away', async () => {
    const clock = frames()
    let posted = 0
    const report = createRouteScreenPaintReporter(clock.scheduler, () => {
      posted += 1
    })
    const ScreenA = lazy(async () => withRouteScreenPaintReport({ default: () => null }))

    let tree: ReactTestRenderer | null = null
    await act(async () => {
      tree = create(
        <RouteScreenPaintProvider report={report}>
          <Suspense fallback={null}>
            <ScreenA />
          </Suspense>
        </RouteScreenPaintProvider>
      )
    })
    // Committed and owed two frames; one has passed.
    clock.tick()
    await act(async () => {
      tree?.unmount()
    })
    clock.tick()
    clock.tick()
    expect(posted).toBe(0)
    expect(clock.pending()).toBe(0)
  })

  it('hands the report to the screen that arrived while the last one was still owed a frame', () => {
    const clock = frames()
    let posted = 0
    const report = createRouteScreenPaintReporter(clock.scheduler, () => {
      posted += 1
    })
    report()
    // One of the first screen's two frames has passed.
    clock.tick()
    // The replacement commits, and the screen it replaces stays mounted behind it.
    report()
    clock.tick()
    // The frame that just ran was the replacement's first, not the one the screen behind it was
    // still owed: that frame would report a document the view is no longer showing.
    expect(posted).toBe(0)
    clock.tick()
    expect(posted).toBe(1)
    clock.tick()
    // And nothing is left over to report a second time.
    expect(posted).toBe(1)
    expect(clock.pending()).toBe(0)
  })

  it('leaves the next screen free to report, because a frame taken back was never spent', () => {
    const clock = frames()
    let posted = 0
    const report = createRouteScreenPaintReporter(clock.scheduler, () => {
      posted += 1
    })
    report()()
    const second = report()
    clock.tick()
    clock.tick()
    expect(posted).toBe(1)
    // And that one is spent: a screen leaving after the shell uncovered has nothing to undo.
    second()
    report()
    clock.tick()
    clock.tick()
    expect(posted).toBe(1)
  })
})

describe('which commit the page reports its frame from', () => {
  it('says nothing while the route chunk is still arriving', async () => {
    const route = deferredRouteChunk()
    const Screen = lazy(() => route.chunk.then(withRouteScreenPaintReport))
    let reports = 0
    let commitsAboveTheRouter = 0
    // Shaped like the page: the entry's wrapper sits above expo-router, which puts every screen
    // behind a suspense boundary of its own.
    function WrapperAboveTheRouter({ children }: PropsWithChildren) {
      useEffect(() => {
        commitsAboveTheRouter += 1
      }, [])
      return children
    }
    await act(async () => {
      create(
        <RouteScreenPaintProvider
          report={() => {
            reports += 1
            return () => undefined
          }}
        >
          <WrapperAboveTheRouter>
            <Suspense fallback={null}>
              <Screen />
            </Suspense>
          </WrapperAboveTheRouter>
        </RouteScreenPaintProvider>
      )
    })
    // The gap this seam exists for: the wrapper has committed, against a fallback that drew
    // nothing, and a report hung there would uncover the shell's view over an empty body.
    expect(commitsAboveTheRouter).toBe(1)
    expect(reports).toBe(0)

    await act(async () => {
      route.arrive()
    })
    expect(reports).toBe(1)
  })

  it('reports the screen that arrived and not the one that replaced it', async () => {
    const route = deferredRouteChunk()
    const Screen = lazy(() => route.chunk.then(withRouteScreenPaintReport))
    let reports = 0
    await act(async () => {
      create(
        <RouteScreenPaintProvider
          report={() => {
            reports += 1
            return () => undefined
          }}
        >
          <Suspense fallback={null}>
            <Screen />
          </Suspense>
        </RouteScreenPaintProvider>
      )
    })
    await act(async () => {
      route.arrive()
    })
    // Once per screen that commits: the shell latches the first, and a re-render is not a new one.
    expect(reports).toBe(1)
  })
})
