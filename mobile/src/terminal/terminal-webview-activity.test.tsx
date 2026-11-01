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

it('restores the current activity policy before queued commands on readiness and reload', () => {
  const post = vi.fn()
  const transport = { post, pingsOnForegroundRecovery: () => false }
  let controller: ReturnType<typeof useTerminalWebViewController> | undefined
  function Probe({ active }: { active: boolean }) {
    controller = useTerminalWebViewController({ interactionActive: active }, transport)
    return null
  }
  act(() => {
    root = create(<Probe active={false} />)
  })
  if (!controller) {
    throw new Error('Controller did not mount')
  }
  act(() => controller?.receive({ type: 'web-ready' }))
  expect(post.mock.calls[0][0]).toMatchObject({ type: 'set-interaction-active', active: false })
  act(() => root?.update(<Probe active={true} />))
  expect(post.mock.lastCall?.[0]).toMatchObject({ type: 'set-interaction-active', active: true })
  act(() => controller?.resetReadiness())
  act(() => root?.update(<Probe active={false} />))
  post.mockClear()
  act(() => controller?.receive({ type: 'web-ready' }))
  expect(post.mock.calls[0][0]).toMatchObject({ type: 'set-interaction-active', active: false })
})

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
