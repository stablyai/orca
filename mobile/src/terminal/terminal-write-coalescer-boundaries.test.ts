import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TerminalWebViewCommand } from './terminal-webview-messages'
import { useTerminalWebViewController } from './use-terminal-webview-controller'
import { TERMINAL_WRITE_FLUSH_WINDOW_MS } from './terminal-write-coalescer'

vi.mock('react-native', () => ({
  AppState: { currentState: 'active' },
  Pressable: 'Pressable',
  Text: 'Text',
  View: 'View',
  StyleSheet: { absoluteFillObject: {}, create: (styles: unknown) => styles }
}))
vi.mock('lucide-react-native', () => ({ RefreshCw: 'RefreshCw' }))

let activeRenderer: ReactTestRenderer | undefined

function createTerminalController() {
  const delivered: (TerminalWebViewCommand & { id: number })[] = []
  let controller: ReturnType<typeof useTerminalWebViewController> | undefined
  const transport = {
    post: (command: TerminalWebViewCommand & { id: number }) => {
      delivered.push(command)
    },
    pingsOnForegroundRecovery: () => true
  }
  function Harness() {
    controller = useTerminalWebViewController({}, transport)
    return null
  }
  act(() => {
    activeRenderer = create(createElement(Harness))
  })
  const mountedController = () => controller
  const view = mountedController()
  if (!view) {
    throw new Error('Terminal controller did not mount')
  }
  act(() => {
    view.receive({ type: 'web-ready' })
  })
  delivered.length = 0
  const recover = () => {
    const ping = delivered.find((command) => command.type === 'ping')
    if (!ping) {
      throw new Error('Foreground recovery did not ping the document')
    }
    act(() => {
      view.receive({ type: 'pong', pingId: ping.id })
    })
  }
  const writesAndInits = () =>
    delivered.filter((command) => command.type === 'write' || command.type === 'init')
  return { delivered, view: view.handle, recover, writesAndInits }
}

describe('terminal write coalescer boundaries', () => {
  afterEach(() => {
    act(() => {
      activeRenderer?.unmount()
    })
    activeRenderer = undefined
    vi.useRealTimers()
  })

  it('drops buffered pre-snapshot writes on init (write → clear → init supersession)', () => {
    vi.useFakeTimers()
    const { view, writesAndInits } = createTerminalController()
    act(() => {
      view.write('a')
      view.write('stale-pre-snapshot')
      view.init({ cols: 80, rows: 24, initialData: 'snapshot', frame: null })
      vi.runOnlyPendingTimers()
    })
    expect(writesAndInits()).toMatchObject([
      { type: 'write', data: 'a' },
      { type: 'init', cols: 80, rows: 24, initialData: 'snapshot', frame: null }
    ])
  })

  it('keeps foreground recovery safe: a late timer flush lands before init in FIFO order', () => {
    vi.useFakeTimers()
    const { view, delivered, recover, writesAndInits } = createTerminalController()
    act(() => {
      view.write('live')
      view.write('buffered-mid-recovery')
      view.prepareForForegroundRecovery()
      vi.advanceTimersByTime(TERMINAL_WRITE_FLUSH_WINDOW_MS)
    })
    expect(delivered.map((command) => command.type)).toEqual(['write', 'ping'])
    act(() => {
      view.init({ cols: 80, rows: 24, initialData: 'snapshot', frame: null })
    })
    expect(delivered.map((command) => command.type)).toEqual(['write', 'ping'])
    recover()
    act(() => {
      vi.runOnlyPendingTimers()
    })
    expect(writesAndInits()).toMatchObject([
      { type: 'write', data: 'live' },
      { type: 'write', data: 'buffered-mid-recovery' },
      { type: 'init', cols: 80, rows: 24, initialData: 'snapshot', frame: null }
    ])
  })

  it('delivers the deferred-recovery timer flush when no init follows (skipped recovery)', () => {
    vi.useFakeTimers()
    const { view, delivered, recover, writesAndInits } = createTerminalController()
    act(() => {
      view.write('live')
      view.write('still-current-document')
      view.prepareForForegroundRecovery()
      vi.advanceTimersByTime(TERMINAL_WRITE_FLUSH_WINDOW_MS)
    })
    expect(delivered.map((command) => command.type)).toEqual(['write', 'ping'])
    recover()
    expect(writesAndInits()).toMatchObject([
      { type: 'write', data: 'live' },
      { type: 'write', data: 'still-current-document' }
    ])
  })
})
