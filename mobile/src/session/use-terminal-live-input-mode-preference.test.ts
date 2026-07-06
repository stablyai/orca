import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  readDisabledTerminalLiveInputHandlesPreference,
  saveDisabledTerminalLiveInputHandles,
  type DisabledTerminalLiveInputHandlesPreference
} from '../storage/preferences'
import { useTerminalLiveInputModePreference } from './use-terminal-live-input-mode-preference'

vi.mock('../storage/preferences', () => ({
  readDisabledTerminalLiveInputHandlesPreference: vi.fn(),
  saveDisabledTerminalLiveInputHandles: vi.fn()
}))

type TerminalLiveInputModePreferenceHarness = {
  readonly current: ReturnType<typeof useTerminalLiveInputModePreference>
  readonly unmount: () => void
}

type Deferred<T> = {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
}

function createDeferred<T>(): Deferred<T> {
  let resolve: ((value: T) => void) | null = null
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve
  })
  if (!resolve) {
    throw new Error('deferred resolver was not initialized')
  }
  return { promise, resolve }
}

function suppressReactTestRendererDeprecationWarning(): () => void {
  const originalConsoleError = console.error
  const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation((...args) => {
    const firstArg = args[0]
    if (typeof firstArg === 'string' && firstArg.includes('react-test-renderer is deprecated')) {
      return
    }
    originalConsoleError(...args)
  })
  return () => consoleErrorSpy.mockRestore()
}

function createTerminalLiveInputModePreferenceHarness(): TerminalLiveInputModePreferenceHarness {
  let current: ReturnType<typeof useTerminalLiveInputModePreference> | null = null
  let renderer: ReactTestRenderer | null = null

  function Harness(): null {
    current = useTerminalLiveInputModePreference({
      hostId: 'host-1',
      worktreeId: 'worktree-1'
    })
    return null
  }

  const restoreConsoleError = suppressReactTestRendererDeprecationWarning()
  try {
    act(() => {
      renderer = create(createElement(Harness))
    })
  } finally {
    restoreConsoleError()
  }
  if (!current || !renderer) {
    throw new Error('terminal live input mode preference hook did not render')
  }

  return {
    get current() {
      if (!current) {
        throw new Error('terminal live input mode preference hook is not mounted')
      }
      return current
    },
    unmount: () => {
      act(() => renderer?.unmount())
    }
  }
}

describe('terminal live input mode preference hook', () => {
  beforeEach(() => {
    vi.mocked(readDisabledTerminalLiveInputHandlesPreference).mockReset()
    vi.mocked(saveDisabledTerminalLiveInputHandles).mockReset()
    vi.mocked(saveDisabledTerminalLiveInputHandles).mockResolvedValue()
  })

  it('merges pre-hydration edits with loaded disabled handles', async () => {
    const load = createDeferred<DisabledTerminalLiveInputHandlesPreference>()
    vi.mocked(readDisabledTerminalLiveInputHandlesPreference).mockReturnValue(load.promise)
    const harness = createTerminalLiveInputModePreferenceHarness()

    act(() => {
      harness.current.defaultTerminalHandlesToLiveInput(['pty-1', 'pty-2'])
    })
    act(() => {
      expect(harness.current.toggleTerminalLiveInput('pty-1')).toBe(true)
    })

    await act(async () => {
      load.resolve({ handles: new Set(['pty-2']), loaded: true })
      await load.promise
    })

    expect([...harness.current.liveInputTerminalHandles]).toEqual(['pty-1'])
    expect(saveDisabledTerminalLiveInputHandles).toHaveBeenCalledTimes(1)
    expect(saveDisabledTerminalLiveInputHandles).toHaveBeenCalledWith(
      'host-1',
      'worktree-1',
      new Set(['pty-2'])
    )
    harness.unmount()
  })

  it('does not persist fallback-empty storage reads during clean hydration', async () => {
    const load = createDeferred<DisabledTerminalLiveInputHandlesPreference>()
    vi.mocked(readDisabledTerminalLiveInputHandlesPreference).mockReturnValue(load.promise)
    const harness = createTerminalLiveInputModePreferenceHarness()

    act(() => {
      harness.current.defaultTerminalHandlesToLiveInput(['pty-1'])
    })

    await act(async () => {
      load.resolve({ handles: new Set(), loaded: false })
      await load.promise
    })

    expect([...harness.current.liveInputTerminalHandles]).toEqual(['pty-1'])
    expect(saveDisabledTerminalLiveInputHandles).not.toHaveBeenCalled()
    harness.unmount()
  })
})
