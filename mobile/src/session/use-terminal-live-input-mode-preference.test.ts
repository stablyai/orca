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
  readonly setAgentHandles: (handles: readonly string[]) => void
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

function createTerminalLiveInputModePreferenceHarness(): TerminalLiveInputModePreferenceHarness {
  let current: ReturnType<typeof useTerminalLiveInputModePreference> | null = null
  let renderer: ReactTestRenderer | null = null
  let agentHandles: ReadonlySet<string> = new Set()

  function Harness(): null {
    current = useTerminalLiveInputModePreference({
      hostId: 'host-1',
      worktreeId: 'worktree-1',
      agentHandles
    })
    return null
  }

  act(() => {
    renderer = create(createElement(Harness))
  })
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
    setAgentHandles: (handles) => {
      agentHandles = new Set(handles)
      act(() => renderer?.update(createElement(Harness)))
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

  it('opens agent tabs in the composer and drops a live-keys pick once the agent quits', async () => {
    vi.mocked(readDisabledTerminalLiveInputHandlesPreference).mockResolvedValue({
      handles: new Set(),
      loaded: true
    })
    const harness = createTerminalLiveInputModePreferenceHarness()
    await act(async () => {})
    harness.setAgentHandles(['agent-pty'])
    act(() => {
      harness.current.defaultTerminalHandlesToLiveInput(['agent-pty', 'shell-pty'])
    })
    expect([...harness.current.liveInputTerminalHandles]).toEqual(['shell-pty'])

    act(() => {
      expect(harness.current.toggleTerminalLiveInput('agent-pty')).toBe(true)
    })
    expect(harness.current.liveInputTerminalHandles.has('agent-pty')).toBe(true)

    harness.setAgentHandles([])
    expect(harness.current.liveInputTerminalHandles.has('agent-pty')).toBe(true)
    harness.setAgentHandles(['agent-pty'])
    expect(harness.current.liveInputTerminalHandles.has('agent-pty')).toBe(false)
    expect(saveDisabledTerminalLiveInputHandles).not.toHaveBeenCalled()
    harness.unmount()
  })
})
