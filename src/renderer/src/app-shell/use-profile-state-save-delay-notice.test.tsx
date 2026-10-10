// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const notice = vi.hoisted(() => {
  let nextToastId = 1
  return {
    warning: vi.fn(
      (_title: string, options: { id?: string | number }) => options.id ?? nextToastId++
    ),
    dismiss: vi.fn()
  }
})
vi.mock('sonner', () => ({ toast: notice }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

import { useProfileStateSaveDelayNotice } from './use-profile-state-save-delay-notice'

let snapshot: ReturnType<typeof Promise.withResolvers<boolean>>
const listeners = new Set<(delayed: boolean) => void>()
const subscribe = vi.fn((listener: (delayed: boolean) => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
})
const read = vi.fn(() => snapshot.promise)

beforeEach(() => {
  vi.clearAllMocks()
  snapshot = Promise.withResolvers<boolean>()
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      app: {
        isProfileStateSaveDelayed: read,
        onProfileStateSaveDelayChanged: subscribe
      }
    }
  })
})
afterEach(() => {
  cleanup()
  listeners.clear()
})

function publish(delayed: boolean): void {
  act(() => listeners.forEach((listener) => listener(delayed)))
}

async function resolveSnapshot(delayed: boolean): Promise<void> {
  await act(async () => {
    snapshot.resolve(delayed)
    await snapshot.promise
  })
}

it('restores a persistent warning from main and clears it on completion', async () => {
  renderHook(useProfileStateSaveDelayNotice)
  expect(subscribe.mock.invocationCallOrder[0]).toBeLessThan(read.mock.invocationCallOrder[0])
  await resolveSnapshot(true)
  expect(notice.warning).toHaveBeenCalledExactlyOnceWith(
    'Profile storage is taking longer than usual',
    {
      id: undefined,
      description: 'Further saves may be delayed while this operation finishes.',
      duration: Infinity,
      dismissible: false,
      closeButton: false
    }
  )
  publish(false)
  expect(notice.dismiss).toHaveBeenLastCalledWith(notice.warning.mock.results[0].value)
})

it('does not let an old healthy snapshot erase a newly delayed save', async () => {
  renderHook(useProfileStateSaveDelayNotice)
  publish(true)
  await resolveSnapshot(false)
  expect(notice.warning).toHaveBeenCalledOnce()
  expect(notice.dismiss).not.toHaveBeenCalled()
})

it('does not let an old delayed snapshot restore a recovered warning', async () => {
  renderHook(useProfileStateSaveDelayNotice)
  publish(false)
  await resolveSnapshot(true)
  expect(notice.warning).not.toHaveBeenCalled()
  expect(notice.dismiss).not.toHaveBeenCalled()
})

it('removes its listener and ignores snapshots or queued events after unmount', async () => {
  const view = renderHook(useProfileStateSaveDelayNotice)
  const queuedListener = subscribe.mock.calls[0][0]
  view.unmount()
  expect(listeners.size).toBe(0)
  act(() => queuedListener(true))
  await resolveSnapshot(true)
  expect(notice.warning).not.toHaveBeenCalled()
  expect(notice.dismiss).not.toHaveBeenCalled()
})

it('rehydrates a still-delayed save after the app shell remounts', async () => {
  const first = renderHook(useProfileStateSaveDelayNotice)
  await resolveSnapshot(true)
  first.unmount()
  renderHook(useProfileStateSaveDelayNotice)
  await act(async () => {
    await snapshot.promise
  })
  expect(notice.warning).toHaveBeenCalledTimes(2)
  expect(notice.warning.mock.results[0].value).not.toBe(notice.warning.mock.results[1].value)
  expect(notice.dismiss).toHaveBeenCalledExactlyOnceWith(notice.warning.mock.results[0].value)
})

it('reuses one ID while delayed but gives the next delayed episode a new ID', () => {
  renderHook(useProfileStateSaveDelayNotice)
  publish(true)
  const firstId = notice.warning.mock.results[0].value
  publish(true)
  expect(notice.warning.mock.calls[1][1].id).toBe(firstId)
  publish(false)
  publish(false)
  expect(notice.dismiss).toHaveBeenCalledExactlyOnceWith(firstId)
  publish(true)
  expect(notice.warning.mock.calls[2][1].id).toBeUndefined()
  expect(notice.warning.mock.results[2].value).not.toBe(firstId)
})
