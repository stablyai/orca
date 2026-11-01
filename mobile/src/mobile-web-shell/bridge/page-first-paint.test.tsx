import { Suspense, lazy, useEffect, type ComponentType, type PropsWithChildren } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it } from 'vitest'
import {
  RouteScreenPaintProvider,
  createRouteScreenPaintReporter,
  reportAfterFirstPaint,
  withRouteScreenPaintReport
} from './page-first-paint'

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
    // The first animation callback may run before the commit paints; one frame would uncover an undrawn tree.
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
    clock.tick()
    report()
    clock.tick()
    // The replacement owns this frame; reporting the previous screen would uncover the wrong document.
    expect(posted).toBe(0)
    clock.tick()
    expect(posted).toBe(1)
    clock.tick()
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
    // Match Expo’s deferred-route shape: the entry wrapper sits above each screen’s suspense boundary.
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
    // The wrapper committed only an empty suspense fallback; it must not report first paint before the route chunk arrives.
    expect(commitsAboveTheRouter).toBe(1)
    expect(reports).toBe(0)

    await act(async () => {
      route.arrive()
    })
    expect(reports).toBe(1)
  })
})
