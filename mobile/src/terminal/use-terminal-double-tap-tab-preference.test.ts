import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  loadTerminalDoubleTapTabEnabled,
  saveTerminalDoubleTapTabEnabled
} from '../storage/preferences'
import {
  useTerminalDoubleTapTabPreference,
  type TerminalDoubleTapTabPreference
} from './use-terminal-double-tap-tab-preference'

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

vi.mock('../storage/preferences', () => ({
  loadTerminalDoubleTapTabEnabled: vi.fn(),
  saveTerminalDoubleTapTabEnabled: vi.fn()
}))

describe('useTerminalDoubleTapTabPreference', () => {
  let renderer: ReactTestRenderer | null = null
  let preference: TerminalDoubleTapTabPreference | null = null

  function Harness(): null {
    preference = useTerminalDoubleTapTabPreference()
    return null
  }

  async function mount(): Promise<void> {
    await act(async () => {
      renderer = create(createElement(Harness))
      await Promise.resolve()
    })
  }

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    vi.mocked(loadTerminalDoubleTapTabEnabled).mockReset().mockResolvedValue(false)
    vi.mocked(saveTerminalDoubleTapTabEnabled).mockReset().mockResolvedValue(undefined)
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    preference = null
  })

  it('keeps a fast toggle authoritative over the initial read', async () => {
    const initialLoad = deferred<boolean>()
    vi.mocked(loadTerminalDoubleTapTabEnabled).mockReturnValue(initialLoad.promise)
    await mount()

    act(() => preference?.setEnabled(true))
    expect(preference?.enabled).toBe(true)

    await act(async () => {
      initialLoad.resolve(false)
      await initialLoad.promise
    })

    expect(preference?.enabled).toBe(true)
    expect(saveTerminalDoubleTapTabEnabled).toHaveBeenCalledWith(true)
  })

  it('reloads the persisted value when the latest write fails', async () => {
    vi.mocked(loadTerminalDoubleTapTabEnabled)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
    vi.mocked(saveTerminalDoubleTapTabEnabled).mockRejectedValue(new Error('storage unavailable'))
    await mount()

    await act(async () => {
      preference?.setEnabled(true)
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(preference?.enabled).toBe(false)
    expect(loadTerminalDoubleTapTabEnabled).toHaveBeenCalledTimes(2)
  })

  it('does not let an older failed write roll back a newer choice', async () => {
    const recoveryLoad = deferred<boolean>()
    vi.mocked(loadTerminalDoubleTapTabEnabled)
      .mockResolvedValueOnce(false)
      .mockReturnValueOnce(recoveryLoad.promise)
    vi.mocked(saveTerminalDoubleTapTabEnabled)
      .mockRejectedValueOnce(new Error('storage unavailable'))
      .mockResolvedValueOnce(undefined)
    await mount()

    act(() => preference?.setEnabled(true))
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    act(() => preference?.setEnabled(false))

    await act(async () => {
      recoveryLoad.resolve(true)
      await recoveryLoad.promise
      await Promise.resolve()
    })

    expect(preference?.enabled).toBe(false)
    expect(saveTerminalDoubleTapTabEnabled).toHaveBeenNthCalledWith(2, false)
  })
})
