// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react'
import { StrictMode } from 'react'
import { Toaster } from 'sonner'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useProfileStateSaveDelayNotice } from './use-profile-state-save-delay-notice'

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

const title = 'Profile storage is taking longer than usual'
const frames: FrameRequestCallback[] = []
const listeners = new Set<(delayed: boolean) => void>()

function Notice() {
  useProfileStateSaveDelayNotice()
  return <Toaster />
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  let nextFrameId = 0
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.push(callback)
    return ++nextFrameId
  })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      app: {
        isProfileStateSaveDelayed: () => Promise.resolve(true),
        onProfileStateSaveDelayChanged: (listener: (delayed: boolean) => void) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        }
      }
    }
  })
})

afterEach(() => {
  cleanup()
  listeners.clear()
  frames.length = 0
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

async function advanceTimers(ms = 0): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

async function finishDismissal(): Promise<void> {
  // Sonner publishes dismissal on one frame and applies it on the next.
  for (let frame = 0; frame < 3; frame += 1) {
    await act(async () => {
      for (const callback of frames.splice(0)) {
        callback(performance.now())
      }
      await vi.advanceTimersByTimeAsync(0)
    })
  }
  await advanceTimers(400)
}

function publish(delayed: boolean): void {
  act(() => listeners.forEach((listener) => listener(delayed)))
}

it('keeps the restored warning when an old shell dismissal arrives after remount', async () => {
  const first = render(<Notice />)
  await advanceTimers()
  expect(first.queryByText(title)).not.toBeNull()
  first.unmount()

  const reopened = render(<Notice />)
  await advanceTimers()
  expect(reopened.queryByText(title)).not.toBeNull()
  await finishDismissal()
  expect(reopened.queryAllByText(title)).toHaveLength(1)

  publish(false)
  await finishDismissal()
  expect(reopened.queryByText(title)).toBeNull()
})

it('does not let StrictMode cleanup dismiss the initial delayed snapshot', async () => {
  const view = render(
    <StrictMode>
      <Notice />
    </StrictMode>
  )
  await advanceTimers()
  await finishDismissal()
  expect(listeners.size).toBe(1)
  expect(view.queryAllByText(title)).toHaveLength(1)
})

it('keeps a new warning if recovery and another delay arrive before a dismissal frame', async () => {
  const view = render(<Notice />)
  await advanceTimers()
  expect(view.queryByText(title)).not.toBeNull()

  publish(false)
  publish(true)
  publish(true)
  await advanceTimers()
  await finishDismissal()
  expect(view.queryAllByText(title)).toHaveLength(1)

  publish(false)
  await finishDismissal()
  expect(view.queryByText(title)).toBeNull()
})
