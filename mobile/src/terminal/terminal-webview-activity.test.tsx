import { afterEach, expect, it, vi } from 'vitest'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { useTerminalWebViewController } from './use-terminal-webview-controller'

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

afterEach(() => act(() => root?.unmount()))

it('rejects bridge-delayed gestures while keeping query replies and readiness available', () => {
  const onTerminalInput = vi.fn(),
    onTerminalTap = vi.fn(),
    onFileTap = vi.fn(),
    onOpenUrl = vi.fn()
  const onTerminalQueryReply = vi.fn(),
    onWebReady = vi.fn()
  let controller: ReturnType<typeof useTerminalWebViewController> | undefined
  const transport = { post: vi.fn(), pingsOnForegroundRecovery: () => false }
  function Probe() {
    controller = useTerminalWebViewController(
      {
        interactionActive: false,
        onTerminalInput,
        onTerminalTap,
        onFileTap,
        onOpenUrl,
        onTerminalQueryReply,
        onWebReady
      },
      transport
    )
    return null
  }
  act(() => {
    root = create(<Probe />)
  })
  if (!controller) {
    throw new Error('Controller did not mount')
  }
  controller.receive({ type: 'terminal-input', bytes: '\x1b[A' })
  controller.receive({ type: 'terminal-tap' })
  controller.receive({
    type: 'terminal-file-tap',
    candidates: [{ pathText: '/tmp/file', line: null, column: null }]
  })
  controller.receive({ type: 'open-url', url: 'https://example.com' })
  controller.receive({ type: 'terminal-data', bytes: '\x1b[0n' })
  act(() => controller?.receive({ type: 'web-ready' }))
  for (const handler of [onTerminalInput, onTerminalTap, onFileTap, onOpenUrl]) {
    expect(handler).not.toHaveBeenCalled()
  }
  expect(onTerminalQueryReply).toHaveBeenCalledWith('\x1b[0n')
  expect(onWebReady).toHaveBeenCalledOnce()
})
