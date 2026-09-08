import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  readDefaultSessionViewPreference,
  saveDefaultSessionView,
  type DefaultSessionViewPreference
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
  readDefaultSessionViewPreference: vi.fn(),
  saveDefaultSessionView: vi.fn()
}))

describe('useMobileDefaultSessionViewPreference', () => {
  let renderer: ReactTestRenderer | null = null
  let preference: MobileDefaultSessionViewPreference | null = null

  beforeEach(() => {
    vi.mocked(readDefaultSessionViewPreference)
      .mockReset()
      .mockResolvedValue({ value: 'terminal', loaded: true, hasStoredValue: true })
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

  it('keeps unreadable storage disabled and reports the load failure', async () => {
    vi.mocked(readDefaultSessionViewPreference).mockResolvedValue({
      value: null,
      loaded: false,
      hasStoredValue: false
    })
    await mount()
    expect(preference?.busy).toBe(true)
    expect(preference?.error).toContain('Could not load chat preferences')
  })

  it('exposes loading and save completion before the control becomes enabled', async () => {
    const initialLoad = deferred<DefaultSessionViewPreference>()
    const save = deferred<void>()
    vi.mocked(readDefaultSessionViewPreference).mockReturnValue(initialLoad.promise)
    vi.mocked(saveDefaultSessionView).mockReturnValue(save.promise)
    await mount()
    expect(preference?.busy).toBe(true)
    await act(async () => {
      initialLoad.resolve({ value: 'terminal', loaded: true, hasStoredValue: true })
      await initialLoad.promise
    })
    expect(preference?.busy).toBe(false)
    act(() => preference?.setDefaultView('chat'))
    expect(preference?.busy).toBe(true)
    await act(async () => {
      save.resolve()
      await save.promise
    })
    expect(preference?.busy).toBe(false)
    expect(preference?.defaultView).toBe('chat')
  })

  it('keeps a fast toggle authoritative over the initial read', async () => {
    const initialLoad = deferred<DefaultSessionViewPreference>()
    vi.mocked(readDefaultSessionViewPreference).mockReturnValue(initialLoad.promise)
    await mount()

    expect(preference?.busy).toBe(true)
    act(() => preference?.setDefaultView('chat'))
    expect(preference?.defaultView).toBe('chat')

    await act(async () => {
      initialLoad.resolve({ value: 'terminal', loaded: true, hasStoredValue: true })
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
      .mockResolvedValueOnce({ value: 'terminal', loaded: true, hasStoredValue: true })
      .mockResolvedValueOnce({ value: 'terminal', loaded: true, hasStoredValue: true })
    vi.mocked(saveDefaultSessionView).mockRejectedValue(new Error('storage unavailable'))
    await mount()

    await act(async () => {
      preference?.setDefaultView('chat')
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(preference?.defaultView).toBe('terminal')
    expect(preference?.error).toBe('Could not save chat preferences. Try again.')
    expect(preference?.busy).toBe(false)
    expect(readDefaultSessionViewPreference).toHaveBeenCalledTimes(2)
  })

  it('does not let an older failed write roll back a newer choice', async () => {
    const recoveryLoad = deferred<DefaultSessionViewPreference>()
    vi.mocked(readDefaultSessionViewPreference)
      .mockResolvedValueOnce({ value: 'terminal', loaded: true, hasStoredValue: true })
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
      recoveryLoad.resolve({ value: 'chat', loaded: true, hasStoredValue: true })
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
