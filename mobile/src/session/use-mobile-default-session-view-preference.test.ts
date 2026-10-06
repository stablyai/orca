import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  readDefaultSessionViewPreference,
  saveDefaultSessionView,
  type DefaultSessionViewPreference,
  type MobileSessionView
} from '../storage/session-view-preferences'
import { resetDefaultSessionViewStoreForTests } from '../storage/default-session-view-store'
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
  readDefaultSessionViewPreference: vi.fn(),
  saveDefaultSessionView: vi.fn()
}))

function stored(view: MobileSessionView): DefaultSessionViewPreference {
  return { value: view, loaded: true, hasStoredValue: true }
}

describe('useMobileDefaultSessionViewPreference', () => {
  let renderer: ReactTestRenderer | null = null
  let preference: MobileDefaultSessionViewPreference | null = null

  beforeEach(() => {
    resetDefaultSessionViewStoreForTests()
    vi.mocked(readDefaultSessionViewPreference).mockReset().mockResolvedValue(stored('terminal'))
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
    const initialLoad = deferred<DefaultSessionViewPreference>()
    vi.mocked(readDefaultSessionViewPreference).mockReturnValue(initialLoad.promise)
    await mount()

    act(() => preference?.setDefaultView('chat'))
    expect(preference?.defaultView).toBe('chat')

    await act(async () => {
      initialLoad.resolve(stored('terminal'))
      await initialLoad.promise
    })

    expect(preference?.defaultView).toBe('chat')
    expect(saveDefaultSessionView).toHaveBeenCalledWith('chat')
  })

  it('submits every change immediately so shared persistence preserves event order', async () => {
    const firstSave = deferred<void>()
    vi.mocked(saveDefaultSessionView)
      .mockImplementationOnce(() => firstSave.promise)
      .mockResolvedValue(undefined)
    await mount()

    act(() => preference?.setDefaultView('chat'))
    await act(async () => {
      await Promise.resolve()
    })
    act(() => preference?.setDefaultView('terminal'))
    act(() => preference?.setDefaultView('chat'))
    await act(async () => {
      await Promise.resolve()
    })
    expect(saveDefaultSessionView).toHaveBeenCalledTimes(3)
    expect(saveDefaultSessionView).toHaveBeenNthCalledWith(2, 'terminal')
    expect(saveDefaultSessionView).toHaveBeenNthCalledWith(3, 'chat')

    await act(async () => {
      firstSave.resolve()
      await firstSave.promise
      await Promise.resolve()
    })
    expect(saveDefaultSessionView).toHaveBeenCalledTimes(3)
  })

  it('reloads the persisted value when the latest write fails', async () => {
    vi.mocked(readDefaultSessionViewPreference)
      .mockResolvedValueOnce(stored('terminal'))
      .mockResolvedValueOnce(stored('terminal'))
    vi.mocked(saveDefaultSessionView).mockRejectedValue(new Error('storage unavailable'))
    await mount()

    await act(async () => {
      preference?.setDefaultView('chat')
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(preference?.defaultView).toBe('terminal')
    expect(readDefaultSessionViewPreference).toHaveBeenCalledTimes(2)
  })

  it('does not let an older failed write roll back a newer choice', async () => {
    const recoveryLoad = deferred<DefaultSessionViewPreference>()
    vi.mocked(readDefaultSessionViewPreference)
      .mockResolvedValueOnce(stored('terminal'))
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
      recoveryLoad.resolve(stored('chat'))
      await recoveryLoad.promise
      await Promise.resolve()
    })

    expect(preference?.defaultView).toBe('terminal')
    expect(saveDefaultSessionView).toHaveBeenNthCalledWith(2, 'terminal')
  })

  it('submits the latest write before the Settings route unmounts', async () => {
    const firstSave = deferred<void>()
    vi.mocked(saveDefaultSessionView)
      .mockImplementationOnce(() => firstSave.promise)
      .mockResolvedValueOnce(undefined)
    await mount()

    act(() => preference?.setDefaultView('chat'))
    await act(async () => {
      await Promise.resolve()
    })
    act(() => preference?.setDefaultView('terminal'))
    expect(saveDefaultSessionView).toHaveBeenNthCalledWith(2, 'terminal')
    act(() => renderer?.unmount())
    renderer = null

    await act(async () => {
      firstSave.resolve()
      await firstSave.promise
      await Promise.resolve()
    })
  })
})
