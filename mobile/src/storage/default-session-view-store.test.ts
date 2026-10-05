import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  refreshDefaultSessionView,
  resetDefaultSessionViewStoreForTests,
  setDefaultSessionView,
  useDefaultSessionView,
  type DefaultSessionViewState
} from './default-session-view-store'
import { loadDefaultSessionView, type MobileSessionView } from './session-view-preferences'

vi.mock('./session-view-preferences', () => ({
  DEFAULT_SESSION_VIEW: 'terminal',
  loadDefaultSessionView: vi.fn(),
  saveDefaultSessionView: vi.fn(async () => {})
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe('default session view store (A1c-8)', () => {
  let renderer: ReactTestRenderer | null = null
  const seen: DefaultSessionViewState[] = []

  beforeEach(() => {
    resetDefaultSessionViewStoreForTests()
    seen.length = 0
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  async function mount(): Promise<void> {
    function Session(): null {
      seen.push(useDefaultSessionView())
      return null
    }
    await act(async () => {
      renderer = create(createElement(Session))
      await Promise.resolve()
    })
  }

  it('stays unsettled while a slow read is pending, then settles to the stored value', async () => {
    const read = deferred<MobileSessionView>()
    vi.mocked(loadDefaultSessionView).mockReturnValue(read.promise)
    await mount()
    expect(seen.at(-1)).toEqual({ value: 'terminal', settled: false })
    await act(async () => {
      read.resolve('chat')
      await read.promise
    })
    expect(seen.at(-1)).toEqual({ value: 'chat', settled: true })
  })

  it('settles to terminal when the read fails', async () => {
    vi.mocked(loadDefaultSessionView).mockRejectedValue(new Error('storage unavailable'))
    await mount()
    await act(async () => {
      await Promise.resolve()
    })
    expect(seen.at(-1)).toEqual({ value: 'terminal', settled: true })
  })

  it('reaches a mounted session at once when Settings changes the default', async () => {
    vi.mocked(loadDefaultSessionView).mockResolvedValue('terminal')
    await mount()
    act(() => setDefaultSessionView('chat'))
    expect(seen.at(-1)).toEqual({ value: 'chat', settled: true })
  })

  it('keeps a choice made during a read over what the read saw', async () => {
    const read = deferred<MobileSessionView>()
    vi.mocked(loadDefaultSessionView).mockReturnValue(read.promise)
    await mount()
    act(() => setDefaultSessionView('chat'))
    await act(async () => {
      read.resolve('terminal')
      await read.promise
    })
    expect(seen.at(-1)).toEqual({ value: 'chat', settled: true })
  })

  it('picks up a value the other JS context wrote on refresh', async () => {
    vi.mocked(loadDefaultSessionView).mockResolvedValue('terminal')
    await mount()
    vi.mocked(loadDefaultSessionView).mockResolvedValue('chat')
    await act(async () => {
      await refreshDefaultSessionView()
    })
    expect(seen.at(-1)).toEqual({ value: 'chat', settled: true })
  })
})
