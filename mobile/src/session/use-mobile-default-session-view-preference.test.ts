import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  loadDefaultSessionView,
  saveDefaultSessionView,
  type MobileSessionView
} from '../storage/session-view-preferences'
import {
  useMobileDefaultSessionViewPreference,
  type MobileDefaultSessionViewPreference
} from './use-mobile-default-session-view-preference'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

vi.mock('../storage/session-view-preferences', () => ({
  DEFAULT_SESSION_VIEW: 'terminal',
  loadDefaultSessionView: vi.fn(),
  saveDefaultSessionView: vi.fn()
}))

describe('useMobileDefaultSessionViewPreference', () => {
  let renderer: ReactTestRenderer | null = null
  let preference: MobileDefaultSessionViewPreference | null = null

  beforeEach(() => {
    vi.mocked(loadDefaultSessionView).mockReset().mockResolvedValue('terminal')
    vi.mocked(saveDefaultSessionView).mockReset().mockResolvedValue(undefined)
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    preference = null
  })

  async function mount(): Promise<void> {
    function Harness(): null {
      preference = useMobileDefaultSessionViewPreference()
      return null
    }
    await act(async () => {
      renderer = create(createElement(Harness))
      await Promise.resolve()
    })
  }

  it('keeps a fast toggle authoritative over the initial read', async () => {
    const initialLoad = deferred<MobileSessionView>()
    vi.mocked(loadDefaultSessionView).mockReturnValue(initialLoad.promise)
    await mount()

    act(() => preference?.setDefaultView('chat'))
    expect(preference?.defaultView).toBe('chat')

    await act(async () => {
      initialLoad.resolve('terminal')
      await initialLoad.promise
    })

    expect(preference?.defaultView).toBe('chat')
    expect(saveDefaultSessionView).toHaveBeenCalledWith('chat')
  })

  it('does not let an older failed write roll back a newer choice', async () => {
    const recoveryLoad = deferred<MobileSessionView>()
    vi.mocked(loadDefaultSessionView)
      .mockResolvedValueOnce('terminal')
      .mockReturnValueOnce(recoveryLoad.promise)
    vi.mocked(saveDefaultSessionView)
      .mockRejectedValueOnce(new Error('storage unavailable'))
      .mockResolvedValueOnce(undefined)
    await mount()

    act(() => preference?.setDefaultView('chat'))
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    act(() => preference?.setDefaultView('terminal'))

    await act(async () => {
      recoveryLoad.resolve('chat')
      await recoveryLoad.promise
      await Promise.resolve()
    })

    expect(preference?.defaultView).toBe('terminal')
    expect(saveDefaultSessionView).toHaveBeenNthCalledWith(2, 'terminal')
  })
})
