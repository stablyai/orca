import { Suspense, lazy, useEffect, type ComponentType, type PropsWithChildren } from 'react'
import { act, create } from 'react-test-renderer'
import { describe, expect, it } from 'vitest'
import {
  RouteScreenPaintProvider,
  reportAfterFirstPaint,
  withRouteScreenPaintReport
} from './page-first-paint'

/** Frames the caller drains by hand, so "one frame later" is a step rather than a wait. */
function frames() {
  const queued: (() => void)[] = []
  return {
    schedule: (callback: () => void) => {
      queued.push(callback)
    },
    tick: () => {
      const next = queued.shift()
      next?.()
    },
    pending: () => queued.length
  }
}

describe('when the page says it has a frame', () => {
  it('waits for a frame boundary past the commit, never the same one', () => {
    // One frame is the frame that paints the commit, and a callback inside it can still run ahead
    // of the paint. Reporting there would uncover the view over a tree nothing has drawn.
    const clock = frames()
    let reported = 0
    reportAfterFirstPaint(clock.schedule, () => {
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
    reportAfterFirstPaint(clock.schedule, () => {})
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
