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
import {
  readDefaultSessionViewPreference,
  type DefaultSessionViewPreference,
  type MobileSessionView
} from './session-view-preferences'

vi.mock('./session-view-preferences', () => ({
  DEFAULT_SESSION_VIEW: 'terminal',
  readDefaultSessionViewPreference: vi.fn(),
  saveDefaultSessionView: vi.fn(async () => {})
}))

function stored(view: MobileSessionView | null): DefaultSessionViewPreference {
  return { value: view, loaded: true, hasStoredValue: view !== null }
}

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
    const read = deferred<DefaultSessionViewPreference>()
    vi.mocked(readDefaultSessionViewPreference).mockReturnValue(read.promise)
    await mount()
    expect(seen.at(-1)).toEqual({ value: 'terminal', settled: false, hasStoredValue: false })
    await act(async () => {
      read.resolve(stored('chat'))
      await read.promise
    })
    expect(seen.at(-1)).toEqual({ value: 'chat', settled: true, hasStoredValue: true })
  })

  it('settles to terminal with no stored choice when the read fails', async () => {
    vi.mocked(readDefaultSessionViewPreference).mockResolvedValue({
      value: null,
      loaded: false,
      hasStoredValue: false
    })
    await mount()
    await act(async () => {
      await Promise.resolve()
    })
    expect(seen.at(-1)).toEqual({ value: 'terminal', settled: true, hasStoredValue: false })
  })

  it('shows terminal but records no choice while the user never set one', async () => {
    vi.mocked(readDefaultSessionViewPreference).mockResolvedValue(stored(null))
    await mount()
    await act(async () => {
      await Promise.resolve()
    })
    expect(seen.at(-1)).toEqual({ value: 'terminal', settled: true, hasStoredValue: false })
  })

  it('reaches a mounted session at once when Settings changes the default', async () => {
    vi.mocked(readDefaultSessionViewPreference).mockResolvedValue(stored(null))
    await mount()
    act(() => setDefaultSessionView('chat'))
    expect(seen.at(-1)).toEqual({ value: 'chat', settled: true, hasStoredValue: true })
  })

  it('keeps a choice made during a read over what the read saw', async () => {
    const read = deferred<DefaultSessionViewPreference>()
    vi.mocked(readDefaultSessionViewPreference).mockReturnValue(read.promise)
    await mount()
    act(() => setDefaultSessionView('chat'))
    await act(async () => {
      read.resolve(stored('terminal'))
      await read.promise
    })
    expect(seen.at(-1)).toEqual({ value: 'chat', settled: true, hasStoredValue: true })
  })

  it('picks up a value the other JS context wrote on refresh', async () => {
    vi.mocked(readDefaultSessionViewPreference).mockResolvedValue(stored('terminal'))
    await mount()
    vi.mocked(readDefaultSessionViewPreference).mockResolvedValue(stored('chat'))
    await act(async () => {
      await refreshDefaultSessionView()
    })
    expect(seen.at(-1)).toEqual({ value: 'chat', settled: true, hasStoredValue: true })
  })
})
