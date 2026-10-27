import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import {
  useTerminalWebViewController,
  type TerminalWebViewTransport
} from './use-terminal-webview-controller'

vi.mock('react-native', () => ({ AppState: { currentState: 'active' } }))

vi.mock('./terminal-webview-engine-error-state', () => ({
  useTerminalWebViewEngineErrorState: () => ({
    clearEngineError: vi.fn(),
    engineError: null,
    reportEngineError: vi.fn(),
    reportNativeEngineError: vi.fn()
  })
}))

let root: ReactTestRenderer | undefined

function mountController() {
  const post = vi.fn<TerminalWebViewTransport['post']>()
  const onTerminalInput = vi.fn()
  const exposed: { current: ReturnType<typeof useTerminalWebViewController> | null } = {
    current: null
  }
  const transport = { post, pingsOnForegroundRecovery: () => false }
  function Probe() {
    exposed.current = useTerminalWebViewController({ onTerminalInput }, transport)
    return null
  }
  act(() => {
    root = create(<Probe />)
  })
  const controller = exposed.current
  if (!controller) {
    throw new Error('Controller did not mount')
  }
  act(() => controller.receive({ type: 'web-ready' }))
  const writes = () =>
    post.mock.calls
      .map(([command]) => command)
      .filter((command) => command.type === 'write')
      .map((command) => command.data)
  return { controller, onTerminalInput, writes }
}

describe('terminal scroll response batching', () => {
  afterEach(() => {
    act(() => root?.unmount())
    root = undefined
    vi.useRealTimers()
  })

  it.each(['\x1b[<64;2;2M', '\x1b[A'])('shortens pending output for gesture %j', (bytes) => {
    vi.useFakeTimers()
    const { controller, onTerminalInput, writes } = mountController()
    controller.handle.write('first')
    vi.advanceTimersByTime(5)
    controller.handle.write('response')
    vi.advanceTimersByTime(3)
    controller.receive({ type: 'terminal-input', bytes })
    vi.advanceTimersByTime(8)
    expect(writes()).toEqual(['first', 'response'])
    expect(onTerminalInput).toHaveBeenCalledWith(bytes)
  })

  it.each(['', 'ordinary text', 123])('keeps ordinary batching for non-gesture %j', (bytes) => {
    vi.useFakeTimers()
    const { controller, writes } = mountController()
    controller.handle.write('first')
    controller.handle.write('pending')
    controller.receive({ type: 'terminal-input', bytes })
    vi.advanceTimersByTime(16)
    expect(writes()).toEqual(['first'])
    vi.advanceTimersByTime(32)
    expect(writes()).toEqual(['first', 'pending'])
  })

  it('drops pending gesture output before a new document snapshot', () => {
    vi.useFakeTimers()
    const { controller, writes } = mountController()
    controller.handle.write('first')
    controller.handle.write('stale')
    controller.receive({ type: 'terminal-input', bytes: '\x1b[A' })
    controller.handle.init({ cols: 80, rows: 24, initialData: 'snapshot', frame: null })
    vi.advanceTimersByTime(48)
    expect(writes()).toEqual(['first'])
  })
})
